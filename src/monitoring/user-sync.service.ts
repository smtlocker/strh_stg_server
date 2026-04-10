import { Injectable, Logger } from '@nestjs/common';
import { Subject, Observable } from 'rxjs';
import { randomUUID } from 'crypto';
import {
  StoreganiseApiService,
  SgUser,
} from '../storeganise/storeganise-api.service';
import { DatabaseService } from '../database/database.service';
import { SyncLogService } from './sync-log.service';
import { normalizePhone, formatName } from '../common/utils';
import * as sql from 'mssql';

export interface UserSyncEvent {
  type:
    | 'progress'
    | 'user-success'
    | 'user-skipped'
    | 'user-error'
    | 'user-retry'
    | 'complete'
    | 'stopped';
  jobId: string;
  userId?: string;
  userName?: string;
  current: number;
  total: number;
  succeeded?: number;
  failed?: number;
  skipped?: number;
  error?: string;
  attempt?: number;
  maxAttempts?: number;
}

interface UserSyncJob {
  id: string;
  subject: Subject<UserSyncEvent>;
  running: boolean;
  stopRequested: boolean;
  total: number;
  current: number;
  succeeded: number;
  failed: number;
  skipped: number;
}

const CONCURRENCY = 3;

@Injectable()
export class UserSyncService {
  private readonly logger = new Logger(UserSyncService.name);
  private readonly jobs = new Map<string, UserSyncJob>();

  constructor(
    private readonly sgApi: StoreganiseApiService,
    private readonly db: DatabaseService,
    private readonly syncLog: SyncLogService,
  ) {}

  isRunning(): boolean {
    for (const job of this.jobs.values()) {
      if (job.running) return true;
    }
    return false;
  }

  stopSync(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job || !job.running) return false;
    job.stopRequested = true;
    this.logger.log(`[userSync] Stop requested for job ${jobId}`);
    return true;
  }

  startSync(): string {
    if (this.isRunning()) {
      throw new Error('User sync is already running');
    }

    const jobId = `us-${Date.now()}`;
    const subject = new Subject<UserSyncEvent>();
    const job: UserSyncJob = {
      id: jobId,
      subject,
      running: true,
      stopRequested: false,
      total: 0,
      current: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
    };
    this.jobs.set(jobId, job);

    void this.runSync(job).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`[userSync] Fatal error: ${message}`);
    });

    return jobId;
  }

  getJobStream(jobId: string): Observable<UserSyncEvent> | null {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    return job.subject.asObservable();
  }

  private async runSync(job: UserSyncJob): Promise<void> {
    const users = await this.sgApi.getAllUsers();
    job.total = users.length;

    this.logger.log(
      `[userSync] Starting sync — ${users.length} users, concurrency=${CONCURRENCY}`,
    );

    for (let i = 0; i < users.length; i += CONCURRENCY) {
      if (job.stopRequested) {
        job.subject.next({
          type: 'stopped',
          jobId: job.id,
          current: job.current,
          total: job.total,
          succeeded: job.succeeded,
          failed: job.failed,
          skipped: job.skipped,
        });
        job.subject.complete();
        job.running = false;
        this.logger.log(`[userSync] Stopped at ${job.current}/${job.total}`);
        return;
      }

      const batch = users.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map((user) => this.syncOneUser(job, user)));

      job.subject.next({
        type: 'progress',
        jobId: job.id,
        current: job.current,
        total: job.total,
        succeeded: job.succeeded,
        failed: job.failed,
        skipped: job.skipped,
      });
    }

    job.subject.next({
      type: 'complete',
      jobId: job.id,
      current: job.total,
      total: job.total,
      succeeded: job.succeeded,
      failed: job.failed,
      skipped: job.skipped,
    });
    job.subject.complete();
    job.running = false;

    this.logger.log(
      `[userSync] Complete — ${job.succeeded} succeeded, ${job.failed} failed, ${job.skipped} skipped`,
    );

    setTimeout(() => this.jobs.delete(job.id), 5 * 60 * 1000);
  }

  private async syncOneUser(job: UserSyncJob, user: SgUser): Promise<void> {
    const userId = user.id;
    const startTime = Date.now();
    const maxRetries = 3;
    const corrId = randomUUID();

    const rawPhone =
      user.phone ??
      ((user as Record<string, unknown>)['phoneNumber'] as string) ??
      '';
    const rawLastName = user.lastName ?? '';
    const rawFirstName = user.firstName ?? '';
    const userPhone = normalizePhone(rawPhone);
    const userName = formatName(rawLastName, rawFirstName);

    if (!userPhone) {
      job.skipped++;
      job.current++;
      job.subject.next({
        type: 'user-skipped',
        jobId: job.id,
        userId,
        userName: userName || user.name || userId,
        current: job.current,
        total: job.total,
        error: '전화번호 없음',
      });
      return;
    }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const transaction = await this.db.beginTransaction();
        try {
          // tblPTIUserInfo — StgUserId 우선, phone fallback
          const ptiReq1 = new sql.Request(transaction);
          ptiReq1.input('userName', sql.NVarChar, userName);
          ptiReq1.input('userPhone', sql.NVarChar, userPhone);
          ptiReq1.input('stgUserId', sql.NVarChar, userId);
          const ptiResult1 = await ptiReq1.query(
            `UPDATE tblPTIUserInfo
                SET UserName = @userName, UserPhone = @userPhone, UpdateTime = GETDATE()
              WHERE StgUserId = @stgUserId`,
          );

          if (ptiResult1.rowsAffected[0] === 0) {
            const ptiReq2 = new sql.Request(transaction);
            ptiReq2.input('userName', sql.NVarChar, userName);
            ptiReq2.input('stgUserId', sql.NVarChar, userId);
            ptiReq2.input('userPhone', sql.NVarChar, userPhone);
            await ptiReq2.query(
              `UPDATE tblPTIUserInfo
                  SET UserName = @userName, StgUserId = @stgUserId, UpdateTime = GETDATE()
                WHERE UserPhone = @userPhone AND StgUserId IS NULL`,
            );
          }

          // tblBoxMaster — userCode(=StgUserId) 우선, phone fallback
          const boxReq1 = new sql.Request(transaction);
          boxReq1.input('userName', sql.NVarChar, userName);
          boxReq1.input('userPhone', sql.NVarChar, userPhone);
          boxReq1.input('stgUserId', sql.NVarChar, userId);
          const boxResult1 = await boxReq1.query(
            `UPDATE tblBoxMaster
                SET userName = @userName, userPhone = @userPhone, updateTime = GETDATE()
              WHERE userCode = @stgUserId`,
          );

          if (boxResult1.rowsAffected[0] === 0) {
            const boxReq2 = new sql.Request(transaction);
            boxReq2.input('userName', sql.NVarChar, userName);
            boxReq2.input('stgUserId', sql.NVarChar, userId);
            boxReq2.input('userPhone', sql.NVarChar, userPhone);
            await boxReq2.query(
              `UPDATE tblBoxMaster
                  SET userName = @userName, userCode = @stgUserId, updateTime = GETDATE()
                WHERE userPhone = @userPhone AND (userCode = @userPhone OR userCode IS NULL OR userCode = '')`,
            );
          }

          await transaction.commit();
        } catch (err) {
          await transaction.rollback();
          throw err;
        }

        job.succeeded++;
        job.current++;
        job.subject.next({
          type: 'user-success',
          jobId: job.id,
          userId,
          userName,
          current: job.current,
          total: job.total,
          attempt,
          maxAttempts: maxRetries,
        });

        void this.syncLog.add({
          source: 'user-sync',
          eventType: 'user.synced',
          eventId: job.id,
          correlationKey: corrId,
          businessCode: null,
          areaCode: null,
          showBoxNo: null,
          userName,
          stgUserId: userId,
          stgUnitId: null,
          status: 'success',
          attempt,
          maxAttempts: maxRetries,
          durationMs: Date.now() - startTime,
          error: null,
          payload: { userId, userPhone, attempt, maxAttempts: maxRetries },
        });
        return;
      } catch (err) {
        const errorMsg = (err as Error).message;
        const lower = errorMsg.toLowerCase();
        const isRetryable = [
          'deadlock',
          'timeout',
          'timed out',
          'network_error',
          'econnreset',
          'econnrefused',
          'etimedout',
          '429',
          ' 500',
          ' 502',
          ' 503',
          ' 504',
          'database connection not available',
        ].some((token) => lower.includes(token));

        if (isRetryable && attempt < maxRetries) {
          const backoff = 1000 * Math.pow(2, attempt - 1);
          this.logger.warn(
            `[userSync] Retryable error on ${userName || userId}, retry ${attempt}/${maxRetries} in ${backoff}ms`,
          );
          job.subject.next({
            type: 'user-retry',
            jobId: job.id,
            userId,
            userName,
            current: job.current,
            total: job.total,
            attempt,
            maxAttempts: maxRetries,
            error: errorMsg,
          });
          void this.syncLog.add(
            {
              source: 'user-sync',
              eventType: 'user.synced',
              eventId: job.id,
              correlationKey: corrId,
              businessCode: null,
              areaCode: null,
              showBoxNo: null,
              userName,
              stgUserId: userId,
              stgUnitId: null,
              status: 'error',
              attempt,
              maxAttempts: maxRetries,
              durationMs: Date.now() - startTime,
              error: `[${attempt}/${maxRetries}] ${errorMsg}`,
              payload: {
                userId,
                userPhone,
                attempt,
                maxAttempts: maxRetries,
                retrying: true,
              },
            },
            { suppressAlert: true },
          );
          await new Promise((r) => setTimeout(r, backoff));
          continue;
        }

        job.failed++;
        job.current++;
        job.subject.next({
          type: 'user-error',
          jobId: job.id,
          userId,
          userName,
          current: job.current,
          total: job.total,
          error: errorMsg,
          attempt,
          maxAttempts: maxRetries,
        });

        void this.syncLog.add({
          source: 'user-sync',
          eventType: 'user.synced',
          eventId: job.id,
          correlationKey: corrId,
          businessCode: null,
          areaCode: null,
          showBoxNo: null,
          userName,
          stgUserId: userId,
          stgUnitId: null,
          status: 'error',
          attempt,
          maxAttempts: maxRetries,
          durationMs: Date.now() - startTime,
          error: `[${attempt}/${maxRetries}] ${errorMsg}`,
          payload: { userId, userPhone, attempt, maxAttempts: maxRetries },
        });

        this.logger.warn(
          `[userSync] User ${userName || userId} failed: ${errorMsg}`,
        );
        return;
      }
    }
  }
}

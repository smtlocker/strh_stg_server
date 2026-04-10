import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import * as sql from 'mssql';
import { Inject, forwardRef } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { SyncLogService } from '../monitoring/sync-log.service';
import { WebhookService } from '../webhook/webhook.service';
import { WebhookPayloadDto } from '../webhook/dto/webhook-payload.dto';
import { buildWebhookDedupKey } from '../common/webhook-dedup';
import {
  insertBoxHistorySnapshot,
  setPtiUserEnableAllForGroup,
} from '../common/db-utils';
import { ScheduledJobRepository } from './scheduled-job.repository';
import {
  MAX_ATTEMPTS_DEFAULT,
  PROCESSING_TIMEOUT_MINUTES,
  RETRY_BACKOFF_MINUTES,
  STALE_THRESHOLD_HOURS,
  SCHEDULED_JOB_SYNC_LOG_EVENT,
  ScheduledJobEventType,
  ScheduledJobRow,
} from './scheduled-job.types';

/**
 * 결과 코드.
 * worker가 각 job 실행 후 상태 전이를 결정하기 위해 사용.
 */
type JobExecutionResult =
  | { kind: 'success' }
  | { kind: 'skipped'; reason: string }
  | { kind: 'error'; error: Error };

/**
 * 스케줄러 worker.
 *
 * 1분 단위로 tblScheduledJob을 폴링하여 due pending job을 실행한다.
 * 기존 UnifiedSchedulerService의 자정/23:59:59 상태 추론 cron을 대체한다.
 *
 * 흐름:
 *   1. tick 시작
 *   2. stuck scanner — processing이 10분 이상 멈춰있는 job을 pending으로 회수
 *   3. stale scanner — 48h 초과 pending을 stale로 마킹 + syncLog(alert)
 *   4. fetchDue() — pending + due + (nextRetryAt 도래) 조회
 *   5. 각 job마다:
 *      a. markProcessing (attempts++)
 *      b. dispatch → eventType별 handler 호출
 *      c. 결과에 따라 markSuccess / markSkipped / markRetryPending / markFailed
 *      d. syncLog 기록 (source='scheduler', 기존 eventType 재사용)
 */
@Injectable()
export class ScheduledJobWorkerService {
  private readonly logger = new Logger(ScheduledJobWorkerService.name);
  private isRunning = false;

  constructor(
    private readonly db: DatabaseService,
    private readonly repo: ScheduledJobRepository,
    private readonly syncLog: SyncLogService,
    @Inject(forwardRef(() => WebhookService))
    private readonly webhookService: WebhookService,
  ) {}

  // ---------------------------------------------------------------------------
  // Cron entry point — 1분 주기
  // ---------------------------------------------------------------------------
  @Cron(CronExpression.EVERY_MINUTE)
  async tick(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('[tick] Previous tick still running, skipping');
      return;
    }
    this.isRunning = true;

    try {
      await this.processStuckProcessing();
      await this.processStaleJobs();
      await this.processDueJobs();
    } catch (err) {
      this.logger.error(`[tick] Unhandled error: ${(err as Error).message}`);
    } finally {
      this.isRunning = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Stuck processing scanner
  // ---------------------------------------------------------------------------

  /**
   * processing 상태에서 10분 이상 진전이 없는 job을 pending으로 회수.
   * worker process crash, DB 연결 단절 등으로 markSuccess/markFailed가 누락된 경우
   * job이 영구히 processing에 stuck되는 것을 방어한다.
   *
   * 회수된 job은 attempts 카운트를 유지하므로 maxAttempts를 우회하지 않는다.
   */
  private async processStuckProcessing(): Promise<void> {
    const reclaimed = await this.repo.reclaimStuckProcessing(
      PROCESSING_TIMEOUT_MINUTES,
    );
    if (reclaimed.length === 0) return;

    this.logger.warn(
      `[stuck] Reclaimed ${reclaimed.length} stuck processing job(s) (>${PROCESSING_TIMEOUT_MINUTES}m)`,
    );
    for (const job of reclaimed) {
      this.logger.warn(
        `[stuck] #${job.jobId} ${job.eventType} ${job.areaCode}:${job.showBoxNo} attempts=${job.attempts}`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Stale scanner
  // ---------------------------------------------------------------------------

  /** 48h 경과 pending을 stale로 전이 + 알림 */
  private async processStaleJobs(): Promise<void> {
    const staleJobs = await this.repo.markStaleOlderThan(STALE_THRESHOLD_HOURS);
    if (staleJobs.length === 0) return;

    this.logger.warn(
      `[stale] ${staleJobs.length} job(s) exceeded ${STALE_THRESHOLD_HOURS}h threshold`,
    );

    for (const job of staleJobs) {
      await this.recordSyncLogError(
        job,
        `Exceeded ${STALE_THRESHOLD_HOURS}h staleness threshold (scheduledAt=${job.scheduledAt.toISOString()})`,
        0,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Due scanner + dispatcher
  // ---------------------------------------------------------------------------

  private async processDueJobs(): Promise<void> {
    const dueJobs = await this.repo.fetchDue();
    if (dueJobs.length === 0) return;

    this.logger.log(`[tick] Processing ${dueJobs.length} due job(s)`);

    for (const job of dueJobs) {
      await this.runJob(job);
    }
  }

  private async runJob(job: ScheduledJobRow): Promise<void> {
    const startTime = Date.now();
    const maxAttempts = job.maxAttempts || MAX_ATTEMPTS_DEFAULT;

    // 시작: processing으로 전이
    await this.repo.markProcessing(job.jobId);
    const currentAttempt = job.attempts + 1; // markProcessing에서 +1 되었음

    try {
      const result = await this.dispatch(job);

      if (result.kind === 'success') {
        await this.repo.markSuccess(job.jobId);
        await this.recordSyncLogSuccess(
          job,
          Date.now() - startTime,
          currentAttempt,
        );
        this.logger.log(
          `[job.success] #${job.jobId} ${job.eventType} ${job.areaCode}:${job.showBoxNo}`,
        );
        return;
      }

      if (result.kind === 'skipped') {
        await this.repo.markSkipped(job.jobId, result.reason);
        this.logger.log(
          `[job.skipped] #${job.jobId} ${job.eventType} ${job.areaCode}:${job.showBoxNo} reason="${result.reason}"`,
        );
        return;
      }

      // error 분기
      await this.handleJobError(
        job,
        result.error,
        currentAttempt,
        maxAttempts,
        Date.now() - startTime,
      );
    } catch (err) {
      // dispatch 자체가 던진 경우 (무제어 에러)
      await this.handleJobError(
        job,
        err as Error,
        currentAttempt,
        maxAttempts,
        Date.now() - startTime,
      );
    }
  }

  private async handleJobError(
    job: ScheduledJobRow,
    error: Error,
    currentAttempt: number,
    maxAttempts: number,
    durationMs: number,
  ): Promise<void> {
    const errorMsg = error.message ?? String(error);

    if (currentAttempt < maxAttempts) {
      // 재시도 가능 — backoff 적용
      const backoffIdx = Math.min(
        currentAttempt - 1,
        RETRY_BACKOFF_MINUTES.length - 1,
      );
      const backoffMs = RETRY_BACKOFF_MINUTES[backoffIdx] * 60 * 1000;
      const nextRetryAt = new Date(Date.now() + backoffMs);

      await this.repo.markRetryPending(job.jobId, errorMsg, nextRetryAt);
      this.logger.warn(
        `[job.retry] #${job.jobId} ${job.eventType} ${job.areaCode}:${job.showBoxNo} attempt=${currentAttempt}/${maxAttempts} nextRetryAt=${nextRetryAt.toISOString()} error="${errorMsg}"`,
      );
      return;
    }

    // 최종 실패
    await this.repo.markFailed(job.jobId, errorMsg);
    this.logger.error(
      `[job.failed] #${job.jobId} ${job.eventType} ${job.areaCode}:${job.showBoxNo} final attempt=${currentAttempt}/${maxAttempts} error="${errorMsg}"`,
    );
    await this.recordSyncLogError(
      job,
      errorMsg,
      durationMs,
      currentAttempt,
      maxAttempts,
    );
  }

  // ---------------------------------------------------------------------------
  // EventType dispatcher
  // ---------------------------------------------------------------------------

  private async dispatch(job: ScheduledJobRow): Promise<JobExecutionResult> {
    try {
      switch (job.eventType) {
        case ScheduledJobEventType.MoveInActivate:
          return await this.executeMoveInActivate(job);
        case ScheduledJobEventType.MoveOutBlock:
          return await this.executeMoveOutBlock(job);
        case ScheduledJobEventType.WebhookRetry:
          return await this.executeWebhookRetry(job);
        default:
          return {
            kind: 'error',
            error: new Error(`Unknown eventType: ${String(job.eventType)}`),
          };
      }
    } catch (err) {
      return { kind: 'error', error: err as Error };
    }
  }

  // ---------------------------------------------------------------------------
  // moveIn.activate — useState=3 → useState=1
  // ---------------------------------------------------------------------------
  private async executeMoveInActivate(
    job: ScheduledJobRow,
  ): Promise<JobExecutionResult> {
    if (!job.userPhone) {
      return {
        kind: 'skipped',
        reason: 'userPhone missing — unit no longer assigned',
      };
    }

    const transaction = await this.db.beginTransaction();
    try {
      // 현재 상태 재검증 + overlock/overdue 가드
      const unitResult = await new sql.Request(transaction)
        .input('areaCode', sql.NVarChar, job.areaCode)
        .input('showBoxNo', sql.Int, job.showBoxNo).query<{
        useState: number;
        isOverlocked: number;
        userPhone: string;
      }>(`
          SELECT useState,
                 ISNULL(isOverlocked, 0) AS isOverlocked,
                 ISNULL(userPhone, '') AS userPhone
          FROM tblBoxMaster
          WHERE areaCode = @areaCode AND showBoxNo = @showBoxNo
        `);

      const row = unitResult.recordset[0];
      if (!row) {
        await transaction.rollback();
        return { kind: 'skipped', reason: 'Unit not found in tblBoxMaster' };
      }
      if (row.useState !== 3) {
        await transaction.rollback();
        return {
          kind: 'skipped',
          reason: `useState is ${row.useState}, no longer blocked`,
        };
      }
      if (row.userPhone !== job.userPhone) {
        await transaction.rollback();
        return {
          kind: 'skipped',
          reason: 'userPhone changed since job creation',
        };
      }

      // useState=1 활성화
      await new sql.Request(transaction)
        .input('areaCode', sql.NVarChar, job.areaCode)
        .input('showBoxNo', sql.Int, job.showBoxNo).query(`
          UPDATE tblBoxMaster
          SET useState = 1, updateTime = GETDATE()
          WHERE areaCode = @areaCode AND showBoxNo = @showBoxNo
        `);

      // 같은 그룹에 연체/overlock 유닛이 있으면 게이트는 차단 유지 (Q3/Q8)
      const overdueCheck = await new sql.Request(transaction)
        .input('areaCode', sql.NVarChar, job.areaCode)
        .input('stgUserId', sql.NVarChar, job.userCode)
        .input('userPhone', sql.NVarChar, job.userPhone)
        .query<{ cnt: number }>(
          `SELECT COUNT(*) AS cnt FROM tblBoxMaster
           WHERE areaCode = @areaCode
             AND userCode = @stgUserId
             AND isOverlocked = 1`,
        );
      const hasBlocker = (overdueCheck.recordset[0]?.cnt ?? 0) > 0;

      await setPtiUserEnableAllForGroup(
        transaction,
        job.areaCode,
        job.userPhone,
        hasBlocker ? 0 : 1,
        job.userCode || undefined,
      );
      if (hasBlocker) {
        this.logger.log(
          `[moveIn.activate] Unit activated (useState=1) but group gate stays blocked (isOverlocked exists) — ${job.areaCode}:${job.showBoxNo}`,
        );
      }

      await insertBoxHistorySnapshot(
        transaction,
        job.areaCode,
        job.showBoxNo,
        134,
      );

      await transaction.commit();
      return { kind: 'success' };
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // moveOut.block — useState=1 → useState=3
  // ---------------------------------------------------------------------------
  private async executeMoveOutBlock(
    job: ScheduledJobRow,
  ): Promise<JobExecutionResult> {
    const transaction = await this.db.beginTransaction();
    try {
      const unitResult = await new sql.Request(transaction)
        .input('areaCode', sql.NVarChar, job.areaCode)
        .input('showBoxNo', sql.Int, job.showBoxNo).query<{
        useState: number;
        isOverlocked: number;
        useTimeType: number;
        userPhone: string;
        userCode: string;
      }>(`
          SELECT useState,
                 ISNULL(isOverlocked, 0) AS isOverlocked,
                 ISNULL(useTimeType, 0) AS useTimeType,
                 ISNULL(userPhone, '') AS userPhone,
                 ISNULL(userCode, '') AS userCode
          FROM tblBoxMaster
          WHERE areaCode = @areaCode AND showBoxNo = @showBoxNo
        `);

      const row = unitResult.recordset[0];
      if (!row) {
        await transaction.rollback();
        return { kind: 'skipped', reason: 'Unit not found in tblBoxMaster' };
      }
      if (row.isOverlocked === 1) {
        // overlock 상태는 이미 차단. 그냥 skip (정책 Q18)
        await transaction.rollback();
        return { kind: 'skipped', reason: 'Unit is overlocked by admin' };
      }
      if (row.useTimeType === 98) {
        // Backward compat — prod 잔존 데이터 대응.
        // 과거 (UnifiedSchedulerService 시절) moveOut.completed 가 useTimeType=98 로
        // 마킹하고 EOD reset 을 별도 단계로 미뤘기 때문에 그 마킹이 남아있는 prod
        // row 가 존재할 수 있음. 즉시 reset 정책 도입 후에는 이 마킹이 더 이상
        // 생성되지 않지만, 잔존 데이터의 moveOut.block 자동 차단을 막기 위해
        // 가드를 유지함. prod 데이터 전수 정리 후 이 분기 제거 가능.
        await transaction.rollback();
        return {
          kind: 'skipped',
          reason: 'Unit marked useTimeType=98 (legacy reset flow)',
        };
      }
      if (row.useState !== 1) {
        await transaction.rollback();
        return {
          kind: 'skipped',
          reason: `useState is ${row.useState}, no longer active`,
        };
      }

      // useState=3 차단
      await new sql.Request(transaction)
        .input('areaCode', sql.NVarChar, job.areaCode)
        .input('showBoxNo', sql.Int, job.showBoxNo).query(`
          UPDATE tblBoxMaster
          SET useState = 3, updateTime = GETDATE()
          WHERE areaCode = @areaCode AND showBoxNo = @showBoxNo
        `);

      await insertBoxHistorySnapshot(
        transaction,
        job.areaCode,
        job.showBoxNo,
        142,
      );

      // Q8: 같은 group 내 해당 사용자의 다른 활성 유닛 체크 (자기 자신 제외)
      if (row.userPhone) {
        const otherActiveCheck = await new sql.Request(transaction)
          .input('areaCode', sql.NVarChar, job.areaCode)
          .input('stgUserId', sql.NVarChar, row.userCode || null)
          .input('userPhone', sql.NVarChar, row.userPhone)
          .input('showBoxNo', sql.Int, job.showBoxNo)
          .query<{ cnt: number }>(
            `SELECT COUNT(*) AS cnt FROM tblBoxMaster
             WHERE areaCode = @areaCode
               AND userCode = @stgUserId
               AND useState = 1
               AND showBoxNo <> @showBoxNo`,
          );
        const otherActiveCount = otherActiveCheck.recordset[0]?.cnt ?? 0;

        if (otherActiveCount === 0) {
          // 다른 활성 유닛 없음 — 그룹 PTI 전체 차단 (게이트 차단)
          await setPtiUserEnableAllForGroup(
            transaction,
            job.areaCode,
            row.userPhone,
            0,
            row.userCode || undefined,
          );
        } else {
          this.logger.log(
            `[moveOut.block] PTI preserved (${otherActiveCount} other active unit(s) remain) — ${job.areaCode}:${job.showBoxNo}`,
          );
        }
      }

      await transaction.commit();
      return { kind: 'success' };
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // webhook.retry — 실패한 웹훅 비동기 재시도
  // ---------------------------------------------------------------------------
  private async executeWebhookRetry(
    job: ScheduledJobRow,
  ): Promise<JobExecutionResult> {
    if (!job.payload) {
      return { kind: 'skipped', reason: 'No payload stored for webhook retry' };
    }

    let webhookPayload: WebhookPayloadDto;
    try {
      webhookPayload = JSON.parse(job.payload) as WebhookPayloadDto;
    } catch {
      return {
        kind: 'skipped',
        reason: `Corrupt JSON payload: ${job.payload.substring(0, 200)}`,
      };
    }

    if (!webhookPayload.type) {
      return {
        kind: 'skipped',
        reason: 'Webhook payload missing "type" field',
      };
    }

    await this.webhookService.handle(webhookPayload);
    return { kind: 'success' };
  }

  // ---------------------------------------------------------------------------
  // syncLog 연동
  // ---------------------------------------------------------------------------

  private async recordSyncLogSuccess(
    job: ScheduledJobRow,
    durationMs: number,
    attempt: number,
  ): Promise<void> {
    await this.syncLog.add({
      source: 'scheduler',
      eventType: SCHEDULED_JOB_SYNC_LOG_EVENT[job.eventType],
      eventId: job.sourceEventId ?? null,
      ...this.extractWebhookRetryMeta(job),
      areaCode: job.areaCode,
      showBoxNo: job.showBoxNo,
      userName: job.userName ?? null,
      stgUserId: job.userCode ?? null,
      stgUnitId: null,
      status: 'success',
      attempt,
      maxAttempts: job.maxAttempts || MAX_ATTEMPTS_DEFAULT,
      durationMs,
      error: null,
      payload: { jobId: job.jobId, scheduledAt: job.scheduledAt.toISOString() },
    });
  }

  private async recordSyncLogError(
    job: ScheduledJobRow,
    error: string,
    durationMs: number,
    attempt = job.attempts,
    maxAttempts = job.maxAttempts || MAX_ATTEMPTS_DEFAULT,
  ): Promise<void> {
    await this.syncLog.add({
      source: 'scheduler',
      eventType: SCHEDULED_JOB_SYNC_LOG_EVENT[job.eventType],
      eventId: job.sourceEventId ?? null,
      ...this.extractWebhookRetryMeta(job),
      areaCode: job.areaCode,
      showBoxNo: job.showBoxNo,
      userName: job.userName ?? null,
      stgUserId: job.userCode ?? null,
      stgUnitId: null,
      status: 'error',
      attempt,
      maxAttempts,
      durationMs,
      error,
      payload: { jobId: job.jobId, scheduledAt: job.scheduledAt.toISOString() },
    });
  }

  /**
   * webhook.retry job의 payload에서 businessCode + dedup correlationKey를 추출.
   * dedup 키를 correlationKey로 저장하면 worker 성공 후 같은 웹훅 재수신 시
   * source IN ('webhook','scheduler') 모두에서 dedup이 걸린다.
   */
  private extractWebhookRetryMeta(
    job: ScheduledJobRow,
  ): { businessCode: string | null; correlationKey: string | null } {
    if (job.eventType !== ScheduledJobEventType.WebhookRetry || !job.payload) {
      return {
        businessCode: null,
        correlationKey: job.correlationKey ?? null,
      };
    }
    try {
      const parsed = JSON.parse(job.payload) as Record<string, unknown>;
      return {
        businessCode:
          typeof parsed.businessCode === 'string'
            ? parsed.businessCode
            : null,
        correlationKey: buildWebhookDedupKey(parsed) ?? job.correlationKey ?? null,
      };
    } catch {
      return {
        businessCode: null,
        correlationKey: job.correlationKey ?? null,
      };
    }
  }
}

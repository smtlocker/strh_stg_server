import { Injectable, Logger } from '@nestjs/common';
import * as sql from 'mssql';
import { DatabaseService } from '../database/database.service';
import {
  CreateScheduledJobInput,
  DEFAULT_MAX_ATTEMPTS,
  ScheduledJobEventType,
  ScheduledJobRow,
  WORKER_BATCH_SIZE,
} from './scheduled-job.types';

/**
 * SQL Server unique constraint violation 에러 코드.
 * migration 009의 UQ_ScheduledJob_CorrelationKey_Pending 인덱스 충돌 시 발생.
 */
const SQL_UNIQUE_VIOLATION_NUMBERS = new Set([2601, 2627]);

/**
 * tblScheduledJob DB 액세스 레이어.
 *
 * - 생성/취소: handler가 webhook 트랜잭션 내에서 호출 (transaction 인자 필수)
 * - 조회/실행 상태 변경: worker가 non-transaction 으로 호출 (transaction 선택)
 *
 * PM2 단일 인스턴스 전제이므로 row-level locking 없이 SELECT → UPDATE 로 충분.
 */
@Injectable()
export class ScheduledJobRepository {
  private readonly logger = new Logger(ScheduledJobRepository.name);

  constructor(private readonly db: DatabaseService) {}

  // ---------------------------------------------------------------------------
  // 생성 / 취소 (handler에서 사용, 트랜잭션 필수)
  // ---------------------------------------------------------------------------

  /**
   * Pending job 등록.
   * handler의 tblBoxMaster UPDATE와 동일 트랜잭션에서 호출해야 atomicity 보장.
   *
   * Dedup 정책:
   *   - correlationKey가 있으면 먼저 기존 pending/processing job을 찾아본다.
   *     존재하면 신규 INSERT 없이 기존 jobId를 반환 (webhook 중복 수신 대응).
   *   - 동시성으로 인해 SELECT와 INSERT 사이에 race가 나더라도 migration 009의
   *     filtered unique index(correlationKey + status in (pending/processing))가
   *     최종 방어선. unique violation(2601/2627)이 발생하면 기존 row를 조회해 반환.
   */
  async create(
    transaction: sql.Transaction,
    input: CreateScheduledJobInput,
  ): Promise<number> {
    // 1) correlationKey 기반 사전 dedup
    if (input.correlationKey) {
      const existing = await this.findActiveByCorrelationKey(
        transaction,
        input.correlationKey,
      );
      if (existing) {
        this.logger.log(
          `[job.create.dedup] existing #${existing.jobId} ${input.eventType} correlationKey="${input.correlationKey}"`,
        );
        return existing.jobId;
      }
    }

    const request = new sql.Request(transaction);
    request.input('eventType', sql.NVarChar, input.eventType);
    request.input('scheduledAt', sql.DateTime, input.scheduledAt);
    request.input('areaCode', sql.NVarChar, input.areaCode);
    request.input('showBoxNo', sql.Int, input.showBoxNo);
    request.input('userPhone', sql.NVarChar, input.userPhone ?? null);
    request.input('userCode', sql.NVarChar, input.userCode ?? null);
    request.input('userName', sql.NVarChar, input.userName ?? null);
    request.input(
      'payload',
      sql.NVarChar(4000),
      input.payload ? JSON.stringify(input.payload) : null,
    );
    request.input(
      'sourceEventType',
      sql.NVarChar,
      input.sourceEventType ?? null,
    );
    request.input('sourceEventId', sql.NVarChar, input.sourceEventId ?? null);
    request.input('correlationKey', sql.NVarChar, input.correlationKey ?? null);
    request.input(
      'maxAttempts',
      sql.Int,
      input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    );

    try {
      const result = await request.query<{ jobId: number }>(`
        INSERT INTO tblScheduledJob (
          eventType, scheduledAt, status,
          areaCode, showBoxNo, userPhone, userCode, userName, payload,
          sourceEventType, sourceEventId, correlationKey,
          attempts, maxAttempts, createdAt, updatedAt
        )
        OUTPUT INSERTED.jobId
        VALUES (
          @eventType, @scheduledAt, 'pending',
          @areaCode, @showBoxNo, @userPhone, @userCode, @userName, @payload,
          @sourceEventType, @sourceEventId, @correlationKey,
          0, @maxAttempts, GETDATE(), GETDATE()
        )
      `);

      const jobId = result.recordset[0]?.jobId;
      if (!jobId) {
        throw new Error(
          `Failed to insert scheduled job: ${input.eventType} ${input.areaCode}:${input.showBoxNo}`,
        );
      }
      this.logger.debug(
        `[job.create] #${jobId} ${input.eventType} @${input.scheduledAt.toISOString()} ${input.areaCode}:${input.showBoxNo}`,
      );
      return jobId;
    } catch (err) {
      // 2) unique violation (동시 INSERT race) → 기존 row 반환
      const mssqlErr = err as { number?: number };
      if (
        input.correlationKey &&
        mssqlErr.number !== undefined &&
        SQL_UNIQUE_VIOLATION_NUMBERS.has(mssqlErr.number)
      ) {
        const existing = await this.findActiveByCorrelationKey(
          transaction,
          input.correlationKey,
        );
        if (existing) {
          this.logger.warn(
            `[job.create.dedup-race] existing #${existing.jobId} ${input.eventType} correlationKey="${input.correlationKey}" (resolved via unique violation)`,
          );
          return existing.jobId;
        }
      }
      throw err;
    }
  }

  /**
   * 트랜잭션 없이 단독 INSERT. 웹훅 재시도 스케줄 등 interceptor 에서
   * 트랜잭션 바깥에서 호출할 때 사용.
   */
  async createWithoutTransaction(
    input: CreateScheduledJobInput,
  ): Promise<number> {
    const pool = this.db.getPool();

    // 1) correlationKey 기반 사전 dedup (create()와 동일 패턴)
    if (input.correlationKey) {
      const existing = await this.findActiveByCorrelationKeyDirect(
        pool,
        input.correlationKey,
      );
      if (existing) {
        this.logger.log(
          `[job.createDirect.dedup] existing #${existing.jobId} ${input.eventType} correlationKey="${input.correlationKey}"`,
        );
        return existing.jobId;
      }
    }

    const request = new sql.Request(pool);
    request.input('eventType', sql.NVarChar, input.eventType);
    request.input('scheduledAt', sql.DateTime, input.scheduledAt);
    request.input('areaCode', sql.NVarChar, input.areaCode);
    request.input('showBoxNo', sql.Int, input.showBoxNo);
    request.input('userPhone', sql.NVarChar, input.userPhone ?? null);
    request.input('userCode', sql.NVarChar, input.userCode ?? null);
    request.input('userName', sql.NVarChar, input.userName ?? null);
    request.input(
      'payload',
      sql.NVarChar(4000),
      input.payload ? JSON.stringify(input.payload) : null,
    );
    request.input(
      'sourceEventType',
      sql.NVarChar,
      input.sourceEventType ?? null,
    );
    request.input('sourceEventId', sql.NVarChar, input.sourceEventId ?? null);
    request.input('correlationKey', sql.NVarChar, input.correlationKey ?? null);
    request.input(
      'maxAttempts',
      sql.Int,
      input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    );

    try {
      const result = await request.query<{ jobId: number }>(`
        INSERT INTO tblScheduledJob (
          eventType, scheduledAt, status,
          areaCode, showBoxNo, userPhone, userCode, userName, payload,
          sourceEventType, sourceEventId, correlationKey,
          attempts, maxAttempts, createdAt, updatedAt
        )
        OUTPUT INSERTED.jobId
        VALUES (
          @eventType, @scheduledAt, 'pending',
          @areaCode, @showBoxNo, @userPhone, @userCode, @userName, @payload,
          @sourceEventType, @sourceEventId, @correlationKey,
          0, @maxAttempts, GETDATE(), GETDATE()
        )
      `);

      const jobId = result.recordset[0]?.jobId;
      if (!jobId) {
        throw new Error(
          `Failed to insert scheduled job: ${input.eventType} ${input.areaCode}:${input.showBoxNo}`,
        );
      }
      this.logger.debug(
        `[job.createDirect] #${jobId} ${input.eventType} @${input.scheduledAt.toISOString()}`,
      );
      return jobId;
    } catch (err) {
      // 2) unique violation (동시 INSERT race) → 기존 row 반환
      const mssqlErr = err as { number?: number };
      if (
        input.correlationKey &&
        mssqlErr.number !== undefined &&
        SQL_UNIQUE_VIOLATION_NUMBERS.has(mssqlErr.number)
      ) {
        const existing = await this.findActiveByCorrelationKeyDirect(
          pool,
          input.correlationKey,
        );
        if (existing) {
          this.logger.warn(
            `[job.createDirect.dedup-race] existing #${existing.jobId} ${input.eventType} correlationKey="${input.correlationKey}" (resolved via unique violation)`,
          );
          return existing.jobId;
        }
      }
      throw err;
    }
  }

  /** pool 기반 correlationKey 조회 (트랜잭션 없이). createWithoutTransaction의 dedup용. */
  private async findActiveByCorrelationKeyDirect(
    pool: sql.ConnectionPool,
    correlationKey: string,
  ): Promise<ScheduledJobRow | null> {
    const request = new sql.Request(pool);
    request.input('correlationKey', sql.NVarChar, correlationKey);
    const result = await request.query<ScheduledJobRow>(`
      SELECT TOP 1 *
      FROM tblScheduledJob
      WHERE correlationKey = @correlationKey
        AND status IN ('pending', 'processing')
      ORDER BY jobId ASC
    `);
    return result.recordset[0] ?? null;
  }

  /**
   * 동일 트랜잭션 내에서 correlationKey 기반으로 활성(pending/processing) job 조회.
   * create()의 dedup pre-check 및 unique violation race 해소용.
   */
  private async findActiveByCorrelationKey(
    transaction: sql.Transaction,
    correlationKey: string,
  ): Promise<ScheduledJobRow | null> {
    const request = new sql.Request(transaction);
    request.input('correlationKey', sql.NVarChar, correlationKey);
    const result = await request.query<ScheduledJobRow>(`
      SELECT TOP 1 *
      FROM tblScheduledJob
      WHERE correlationKey = @correlationKey
        AND status IN ('pending', 'processing')
      ORDER BY jobId ASC
    `);
    return result.recordset[0] ?? null;
  }

  /**
   * 특정 unit의 pending job을 eventType 기준으로 취소.
   * webhook에서 "취소/대체" 시나리오 (moveOut.cancelled, 시간 변경 등)에서 호출.
   *
   * @returns 취소된 row 수
   */
  async cancelPendingForUnit(
    transaction: sql.Transaction,
    areaCode: string,
    showBoxNo: number,
    eventTypes: ScheduledJobEventType[],
    reason: string,
  ): Promise<number> {
    if (eventTypes.length === 0) return 0;

    const request = new sql.Request(transaction);
    request.input('areaCode', sql.NVarChar, areaCode);
    request.input('showBoxNo', sql.Int, showBoxNo);
    request.input('reason', sql.NVarChar, reason);

    const placeholders: string[] = [];
    eventTypes.forEach((et, idx) => {
      const paramName = `eventType${idx}`;
      request.input(paramName, sql.NVarChar, et);
      placeholders.push(`@${paramName}`);
    });

    const result = await request.query(`
      UPDATE tblScheduledJob
      SET status = 'cancelled',
          lastError = @reason,
          updatedAt = GETDATE()
      WHERE areaCode = @areaCode
        AND showBoxNo = @showBoxNo
        AND status = 'pending'
        AND eventType IN (${placeholders.join(', ')})
    `);
    const affected = result.rowsAffected[0] ?? 0;
    if (affected > 0) {
      this.logger.log(
        `[job.cancel] ${areaCode}:${showBoxNo} eventTypes=[${eventTypes.join(',')}] affected=${affected} reason="${reason}"`,
      );
    }
    return affected;
  }

  // ---------------------------------------------------------------------------
  // 조회 (worker에서 사용)
  // ---------------------------------------------------------------------------

  /**
   * 실행 가능한 pending job 조회.
   * status='pending' + scheduledAt <= now + (nextRetryAt 없거나 도래) 조건.
   */
  async fetchDue(limit = WORKER_BATCH_SIZE): Promise<ScheduledJobRow[]> {
    const result = await this.db.query<ScheduledJobRow>(
      `SELECT TOP (@limit) *
       FROM tblScheduledJob
       WHERE status = 'pending'
         AND scheduledAt <= GETDATE()
         AND (nextRetryAt IS NULL OR nextRetryAt <= GETDATE())
       ORDER BY scheduledAt ASC, jobId ASC`,
      { limit },
    );
    return result.recordset;
  }

  async findById(jobId: number): Promise<ScheduledJobRow | null> {
    const result = await this.db.query<ScheduledJobRow>(
      `SELECT TOP 1 * FROM tblScheduledJob WHERE jobId = @jobId`,
      { jobId },
    );
    return result.recordset[0] ?? null;
  }

  /**
   * 특정 unit에 대한 pending job이 존재하는지 확인 (handler 가드용).
   */
  async hasPendingForUnit(
    transaction: sql.Transaction,
    areaCode: string,
    showBoxNo: number,
    eventType: ScheduledJobEventType,
  ): Promise<boolean> {
    const request = new sql.Request(transaction);
    request.input('areaCode', sql.NVarChar, areaCode);
    request.input('showBoxNo', sql.Int, showBoxNo);
    request.input('eventType', sql.NVarChar, eventType);

    const result = await request.query<{ cnt: number }>(`
      SELECT COUNT(*) AS cnt FROM tblScheduledJob
      WHERE areaCode = @areaCode
        AND showBoxNo = @showBoxNo
        AND eventType = @eventType
        AND status = 'pending'
    `);
    return (result.recordset[0]?.cnt ?? 0) > 0;
  }

  // ---------------------------------------------------------------------------
  // 실행 상태 변경 (worker에서 사용)
  // ---------------------------------------------------------------------------

  /**
   * pending → processing 전이 + attempts 증가.
   */
  async markProcessing(jobId: number): Promise<void> {
    await this.db.query(
      `UPDATE tblScheduledJob
       SET status = 'processing',
           attempts = attempts + 1,
           updatedAt = GETDATE()
       WHERE jobId = @jobId`,
      { jobId },
    );
  }

  /**
   * processing → success 전이 + executedAt 기록.
   */
  async markSuccess(jobId: number): Promise<void> {
    await this.db.query(
      `UPDATE tblScheduledJob
       SET status = 'success',
           executedAt = GETDATE(),
           updatedAt = GETDATE(),
           lastError = NULL
       WHERE jobId = @jobId`,
      { jobId },
    );
  }

  /**
   * processing → pending 회귀 (재시도).
   * nextRetryAt 이후 fetchDue가 다시 집어올 수 있음.
   */
  async markRetryPending(
    jobId: number,
    error: string,
    nextRetryAt: Date,
  ): Promise<void> {
    await this.db.query(
      `UPDATE tblScheduledJob
       SET status = 'pending',
           nextRetryAt = @nextRetryAt,
           lastError = @error,
           updatedAt = GETDATE()
       WHERE jobId = @jobId`,
      { jobId, nextRetryAt, error },
    );
  }

  /**
   * processing → failed 영구 실패. syncLog + 이메일 알림 대상.
   */
  async markFailed(jobId: number, error: string): Promise<void> {
    await this.db.query(
      `UPDATE tblScheduledJob
       SET status = 'failed',
           lastError = @error,
           executedAt = GETDATE(),
           updatedAt = GETDATE()
       WHERE jobId = @jobId`,
      { jobId, error },
    );
  }

  /**
   * processing → skipped. overlock/overdue 등 가드 발동 시.
   */
  async markSkipped(jobId: number, reason: string): Promise<void> {
    await this.db.query(
      `UPDATE tblScheduledJob
       SET status = 'skipped',
           lastError = @reason,
           executedAt = GETDATE(),
           updatedAt = GETDATE()
       WHERE jobId = @jobId`,
      { jobId, reason },
    );
  }

  /**
   * processing 상태에서 timeoutMinutes 이상 멈춰있는 job을 pending으로 회수.
   * worker process crash 또는 네트워크 단절로 markSuccess/markFailed가 호출되지
   * 못한 경우를 방어. 정상 worker의 한 tick은 수 초 단위이므로 10분 이상
   * processing은 사실상 crash로 간주.
   *
   * 회수된 job은 attempts/nextRetryAt을 유지하여 일반 재시도 흐름에 합류한다.
   * 즉, 이 호출로 인해 maxAttempts를 우회하지 않는다.
   *
   * @returns 회수된 job 목록 (로그/경고용)
   */
  async reclaimStuckProcessing(
    timeoutMinutes: number,
  ): Promise<ScheduledJobRow[]> {
    const result = await this.db.query<ScheduledJobRow>(
      `UPDATE tblScheduledJob
       SET status = 'pending',
           nextRetryAt = NULL,
           lastError = @reason,
           updatedAt = GETDATE()
       OUTPUT INSERTED.*
       WHERE status = 'processing'
         AND updatedAt < DATEADD(minute, -@minutes, GETDATE())`,
      {
        minutes: timeoutMinutes,
        reason: `Reclaimed from stuck processing (>${timeoutMinutes}m)`,
      },
    );
    return result.recordset;
  }

  // ---------------------------------------------------------------------------
  // 운영/재처리용
  // ---------------------------------------------------------------------------

  /**
   * 실시간 피드에서 실패한 스케줄러 job을 수동으로 재처리 큐에 복귀.
   * reprocess.service가 호출한다.
   */
  async requeue(jobId: number): Promise<void> {
    await this.db.query(
      `UPDATE tblScheduledJob
       SET status = 'pending',
           attempts = 0,
           nextRetryAt = NULL,
           lastError = NULL,
           updatedAt = GETDATE()
       WHERE jobId = @jobId
         AND status IN ('failed', 'stale', 'cancelled', 'skipped')`,
      { jobId },
    );
  }
}

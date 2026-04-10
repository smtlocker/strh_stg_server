import { Injectable, Logger } from '@nestjs/common';
import { WebhookHandler } from './handler.interface';
import { WebhookPayloadDto } from '../webhook/dto/webhook-payload.dto';
import { DatabaseService } from '../database/database.service';
import {
  StoreganiseApiService,
  SgUnitRental,
  SgJob,
} from '../storeganise/storeganise-api.service';
import { SyncMeta } from '../monitoring/monitoring.types';
import {
  resolveUnitMapping,
  extractUserInfo,
  normalizePhone,
} from '../common/utils';
import { getSyncLogContext } from '../common/sync-log-context';
import {
  insertBoxHistorySnapshot,
  findExistingAccessCode,
  generateUniqueAccessCode,
  upsertPtiUserForUnit,
  deletePtiUserForUnit,
  setPtiUserEnableAllForGroup,
  safeRollback,
} from '../common/db-utils';
import { ScheduledJobRepository } from '../scheduler/scheduled-job.repository';
import { ScheduledJobEventType } from '../scheduler/scheduled-job.types';
import * as sql from 'mssql';

/**
 * syncWithRental 의 초기 계산 결과 (트랜잭션 밖에서 STG fetch 로 결정되는 값).
 */
interface RentalSyncPlan {
  rental: SgUnitRental;
  ownerId: string;
  userName: string;
  userPhone: string;
  startDate: string | null;
  startTime: string | null;
  /** pending moveOut job 의 date ('YYYY-MM-DD'). 없으면 null. */
  moveOutDate: string | null;
  /** 미래 시작일 여부 */
  isFutureStart: boolean;
  /** 미래 퇴거일 여부 (moveOutDate > 오늘) */
  isFutureMoveOut: boolean;
  isOverlocked: boolean;
  useState: number;
  ptiEnable: 0 | 1;
  /** tblBoxMaster.endTime 에 기록할 문자열 (moveOutDate 있으면 반영, 없으면 2099) */
  endTime: string;
}

@Injectable()
export class UnitSyncHandler implements WebhookHandler {
  private readonly logger = new Logger(UnitSyncHandler.name);

  /** DEBUG: 남은 강제 실패 횟수 (0이면 정상 동작) */
  static __debugFailCount = 0;

  constructor(
    private readonly db: DatabaseService,
    private readonly sgApi: StoreganiseApiService,
    private readonly scheduledJobRepo: ScheduledJobRepository,
  ) {}

  async handle(payload: WebhookPayloadDto): Promise<SyncMeta | void> {
    const changedKeys = payload.data?.changedKeys;
    if (
      !changedKeys ||
      !changedKeys.includes('customFields.smartcube_syncUnit')
    ) {
      return;
    }

    const unitId = payload.data?.unitId;
    if (!unitId) {
      const reason = 'missing unitId in unit.updated payload';
      this.logger.warn(`unit.updated: ${reason}`);
      return { softError: reason };
    }

    // 1. 유닛 정보 조회
    const unit = await this.sgApi.getUnit(unitId);
    const syncRequested = unit.customFields?.['smartcube_syncUnit'] === true;
    if (!syncRequested) {
      this.logger.log(
        `[unitSync] smartcube_syncUnit is false for unit ${unitId}, skipping`,
      );
      return;
    }

    const result = await this.syncUnitWithRetry(unit);
    if (!result) {
      // syncUnit이 null을 반환하는 유일한 경로는 smartcube_id missing/invalid.
      // 체크박스는 리셋하되 운영자가 즉시 알 수 있도록 softError로 표시한다.
      await this.sgApi.updateUnit(unitId, {
        customFields: { smartcube_syncUnit: false },
      });
      const reason = `smartcube_id missing or invalid for unit ${unitId}`;
      return { softError: reason, stgUnitId: unitId };
    }

    // 체크박스 리셋
    await this.sgApi.updateUnit(unitId, {
      customFields: { smartcube_syncUnit: false },
    });
    this.logger.log(
      `[unitSync] ✓ Sync complete, checkbox reset — ${result.areaCode}:${result.showBoxNo}`,
    );

    return result;
  }

  async syncUnitWithRetry(
    unit: Record<string, unknown>,
    maxRetries = 3,
  ): Promise<SyncMeta | null> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // DEBUG: 강제 실패 주입
        if (UnitSyncHandler.__debugFailCount > 0) {
          UnitSyncHandler.__debugFailCount--;
          throw new Error('[DEBUG] Forced deadlock failure on syncUnit');
        }

        return await this.syncUnit(unit);
      } catch (err) {
        lastError = err as Error;
        if (!this.isRetryableSyncError(lastError) || attempt >= maxRetries) {
          break;
        }

        const backoff = 1000 * Math.pow(2, attempt - 1);
        this.logger.warn(
          `[unitSync] Retryable sync error, retry ${attempt}/${maxRetries} in ${backoff}ms: ${lastError.message}`,
        );
        getSyncLogContext()?.recordRetry({
          error: `[unitSync] ${lastError.message}`,
          attempt,
          maxAttempts: maxRetries,
          extra: {
            source: 'unit-sync',
            unitId: (unit as { id?: string }).id ?? null,
          },
        });
        await new Promise((r) => setTimeout(r, backoff));
      }
    }

    if (lastError) throw lastError;
    return null;
  }

  /**
   * 단일 유닛 싱크 (webhook / batch 공용)
   * 체크박스 리셋 없이 순수 싱크만 수행
   */
  async syncUnit(unit: Record<string, unknown>): Promise<SyncMeta | null> {
    const unitId = unit.id as string;

    const parsed = await resolveUnitMapping(this.sgApi, unit);
    if (!parsed) {
      this.logger.warn(
        `[unitSync] smartcube_id missing or invalid for unit ${unitId}`,
      );
      return null;
    }

    const { areaCode, showBoxNo, officeCode } = parsed;
    this.logger.log(
      `[unitSync] Starting sync for unit ${unitId} → areaCode=${areaCode} showBoxNo=${showBoxNo}`,
    );

    const rentalId = unit.rentalId as string | undefined;
    let userName: string | undefined;
    let stgUserId: string | undefined;

    if (rentalId) {
      const rental = await this.sgApi.getUnitRental(rentalId);
      if (!this.isOccupiedRental(rental)) {
        this.logger.log(
          `[unitSync] Non-occupied rental state treated as empty — unitId=${unitId} rentalId=${rentalId} rentalState=${rental.state}`,
        );
        await this.syncEmpty(unitId, areaCode, showBoxNo);
        return { areaCode, showBoxNo, stgUnitId: unitId };
      }

      const info = await this.syncWithRental(
        rental,
        areaCode,
        showBoxNo,
        officeCode,
      );
      userName = info?.userName;
      stgUserId = info?.stgUserId;
    } else {
      await this.syncEmpty(unitId, areaCode, showBoxNo);
    }

    return { areaCode, showBoxNo, stgUnitId: unitId, userName, stgUserId };
  }

  /**
   * STG rental.state 가 'occupied' 일 때만 점유로 인정.
   * 호호락 도메인에서는 move-in completed 이전 상태(reserved/pre_completed 등)를
   * 관리하지 않으므로 그 외 상태는 모두 empty 로 동기화한다.
   *
   * STG 응답에 state 가 누락되어 있으면 이상 신호로 보고 throw — 잘못된
   * 입력으로 DB 를 덮어쓰지 않는다.
   */
  private isOccupiedRental(
    rental: Pick<SgUnitRental, 'id' | 'state'>,
  ): boolean {
    const rentalState = this.normalizeState(rental.state);
    if (!rentalState) {
      throw new Error(
        `[unitSync] rental ${rental.id} has no state — STG response anomaly`,
      );
    }
    return rentalState === 'occupied';
  }

  private normalizeState(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().toLowerCase();
    return normalized ? normalized : null;
  }

  private isRetryableSyncError(err: Error): boolean {
    const msg = (err.message || '').toLowerCase();
    return [
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
    ].some((token) => msg.includes(token));
  }

  /**
   * 트랜잭션 밖에서 STG 에서 필요한 정보를 모두 fetch 하고
   * useState / endTime / schedule 계획을 미리 계산한다.
   */
  private async planRentalSync(rental: SgUnitRental): Promise<RentalSyncPlan> {
    const rentalId = rental.id;
    const ownerId = rental.ownerId;
    if (!ownerId) {
      throw new Error(
        `[unitSync] occupied rental ${rentalId} has no ownerId — STG response anomaly`,
      );
    }
    const user = await this.sgApi.getUser(ownerId);
    const { userPhone, userName } = extractUserInfo(user);
    const startDate = rental.startDate ?? null;
    const rentalCustomFields = (rental.customFields ?? {}) as Record<
      string,
      unknown
    >;

    // STG 기준 오버락 상태 판단 (rental.overdue + lockStatus 통합)
    const lockStatus = rentalCustomFields['smartcube_lockStatus'] as
      | string
      | undefined;
    const isOverlocked = !!rental.overdue || lockStatus === 'overlocked';

    // pending moveOut job 확인 — rental.moveOutJobId 가 있으면 fetch 해서
    // data.date 를 읽어온다. 상태가 'ready'/'running' 일 때만 활성으로 취급.
    const moveOutJobId = (rental as { moveOutJobId?: string }).moveOutJobId;
    let moveOutDate: string | null = null;
    if (moveOutJobId) {
      try {
        const moJob: SgJob = await this.sgApi.getJob(moveOutJobId);
        const activeStates = new Set(['ready', 'running']);
        if (moJob.state && activeStates.has(moJob.state)) {
          const d = moJob.data?.date ?? moJob.data?.moveOutDate;
          if (d) moveOutDate = d;
        }
      } catch (err) {
        this.logger.warn(
          `[unitSync] failed to fetch moveOut job ${moveOutJobId} — ${(err as Error).message} — treating as no pending moveOut`,
        );
      }
    }

    // 오늘/미래 판정 (KST wall clock 기반)
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const isFutureStart = !!(
      startDate && new Date(`${startDate}T00:00:00`) > today
    );
    const isFutureMoveOut = !!(
      moveOutDate && new Date(`${moveOutDate}T00:00:00`) > today
    );

    // useState 결정: overlock(연체 포함) → 3, 미래 시작 → 3, 그 외 → 1
    const useState = isOverlocked ? 3 : isFutureStart ? 3 : 1;
    const ptiEnable: 0 | 1 = useState === 1 ? 1 : 0;
    const startTime = startDate ? `${startDate} 00:00:00` : null;
    const endTime = moveOutDate
      ? `${moveOutDate} 23:59:59`
      : '2099-12-31 23:59:59';

    return {
      rental,
      ownerId,
      userName,
      userPhone,
      startDate,
      startTime,
      moveOutDate,
      isFutureStart,
      isFutureMoveOut,
      isOverlocked,
      useState,
      ptiEnable,
      endTime,
    };
  }

  /**
   * 렌탈이 존재하는 유닛 — STG 렌탈/유저/pending job 데이터로 MSSQL 전체 재구축.
   * overlock, startDate, endTime, PTI, **tblScheduledJob** 까지
   * STG를 source of truth 로 삼아 맞춤.
   */
  private async syncWithRental(
    rental: SgUnitRental,
    areaCode: string,
    showBoxNo: number,
    officeCode: string,
  ): Promise<{ userName: string; stgUserId: string }> {
    const plan = await this.planRentalSync(rental);
    const {
      rental: rentalRef,
      ownerId,
      userName,
      userPhone,
      startTime,
      moveOutDate,
      isFutureStart,
      isFutureMoveOut,
      isOverlocked,
      useState,
      ptiEnable,
      endTime,
    } = plan;
    const rentalId = rentalRef.id;
    const moveOutJobId = (rentalRef as { moveOutJobId?: string }).moveOutJobId;
    const moveInJobId = (rentalRef as { moveInJobId?: string }).moveInJobId;

    let savedAccessCode: string;
    const transaction = await this.db.beginTransaction();
    try {
      // 기존 AccessCode 조회 또는 신규 생성
      const existingAccessCode = await findExistingAccessCode(
        transaction,
        officeCode,
        userPhone,
        ownerId,
      );
      const accessCode =
        existingAccessCode ??
        (await generateUniqueAccessCode(transaction, officeCode));

      // tblBoxMaster 전체 업데이트 (isOverlocked, endTime 포함)
      const req = new sql.Request(transaction);
      req.input('userCode', sql.NVarChar, ownerId);
      req.input('userName', sql.NVarChar, userName);
      req.input('userPhone', sql.NVarChar, userPhone);
      req.input('areaCode', sql.NVarChar, areaCode);
      req.input('showBoxNo', sql.Int, showBoxNo);
      req.input('useState', sql.Int, useState);
      req.input('startTime', sql.NVarChar, startTime);
      req.input('endTime', sql.NVarChar, endTime);
      req.input('isOverlocked', sql.Bit, isOverlocked ? 1 : 0);
      await req.query(`
        UPDATE tblBoxMaster
        SET
          useState      = @useState,
          userCode      = @userCode,
          userName      = @userName,
          userPhone     = @userPhone,
          startTime     = ${startTime ? '@startTime' : 'GETDATE()'},
          endTime       = @endTime,
          isOverlocked  = @isOverlocked,
          updateTime    = GETDATE()
        WHERE areaCode = @areaCode AND showBoxNo = @showBoxNo
      `);

      // PTI upsert (이 유닛의 PTI row)
      await upsertPtiUserForUnit(transaction, {
        areaCode,
        showBoxNo,
        userPhone,
        userName,
        accessCode,
        enable: ptiEnable,
        stgUserId: ownerId,
      });

      // Q8 일관성: upsert 후 항상 group 전체 PTI 를 blocker 상태에 맞춰 일괄 갱신
      // blocker = 이 사용자의 group 내 isOverlocked=1 유닛 (자기 자신 포함)
      const blockerCheck = await new sql.Request(transaction)
        .input('areaCode', sql.NVarChar, areaCode)
        .input('stgUserId', sql.NVarChar, ownerId)
        .input('userPhone', sql.NVarChar, userPhone)
        .query<{ cnt: number }>(
          `SELECT COUNT(*) AS cnt FROM tblBoxMaster
           WHERE areaCode = @areaCode
             AND userCode = @stgUserId
             AND isOverlocked = 1`,
        );

      const hasBlocker = (blockerCheck.recordset[0]?.cnt ?? 0) > 0;
      const groupEnable: 0 | 1 = hasBlocker ? 0 : 1;

      await setPtiUserEnableAllForGroup(
        transaction,
        areaCode,
        userPhone,
        groupEnable,
        ownerId,
      );
      this.logger.log(
        `[unitSync] Group-wide PTI Enable=${groupEnable} (hasBlocker=${hasBlocker})`,
      );

      // History 스냅샷 (eventType=140: unit sync)
      await insertBoxHistorySnapshot(transaction, areaCode, showBoxNo, 140);

      // ─────────────────────────────────────────────────────────
      // tblScheduledJob reconcile — STG 를 source of truth 로 삼아
      // 해당 유닛의 pending moveIn.activate / moveOut.block 스케줄을
      // STG 의 현재 상태에 맞게 재구축한다.
      //
      // 1) 해당 유닛의 pending 스케줄 전부 cancel
      // 2) 미래 startDate → moveIn.activate insert
      // 3) 미래 moveOutDate → moveOut.block insert
      //
      // 당일 이하 moveOutDate 의 경우 handler 분기 정책과 동일하게 스케줄은
      // 당일 23:59:59 에 걸어두고 useState 는 유지 (worker 가 EOD 에 실행).
      // ─────────────────────────────────────────────────────────
      const cancelledSchedules =
        await this.scheduledJobRepo.cancelPendingForUnit(
          transaction,
          areaCode,
          showBoxNo,
          [
            ScheduledJobEventType.MoveInActivate,
            ScheduledJobEventType.MoveOutBlock,
          ],
          'Replaced by unit-sync reconcile (STG truth)',
        );
      if (cancelledSchedules > 0) {
        this.logger.log(
          `[unitSync] cancelled ${cancelledSchedules} existing pending schedule(s) before reconcile`,
        );
      }

      if (isFutureStart && startTime) {
        const activateJobId = await this.scheduledJobRepo.create(transaction, {
          eventType: ScheduledJobEventType.MoveInActivate,
          scheduledAt: new Date(startTime),
          areaCode,
          showBoxNo,
          userPhone,
          userCode: ownerId,
          userName,
          sourceEventType: 'unit.sync',
          sourceEventId: moveInJobId ?? rentalId,
          correlationKey: `unit-sync:moveIn.activate:${rentalId}`,
        });
        this.logger.log(
          `[unitSync] scheduled moveIn.activate job #${activateJobId} @ ${startTime}`,
        );
      }

      if (moveOutDate) {
        const moveOutScheduledAt = `${moveOutDate} 23:59:59`;
        const blockJobId = await this.scheduledJobRepo.create(transaction, {
          eventType: ScheduledJobEventType.MoveOutBlock,
          scheduledAt: new Date(moveOutScheduledAt),
          areaCode,
          showBoxNo,
          userPhone,
          userCode: ownerId,
          userName,
          sourceEventType: 'unit.sync',
          sourceEventId: moveOutJobId ?? rentalId,
          correlationKey: `unit-sync:moveOut.block:${rentalId}`,
        });
        this.logger.log(
          `[unitSync] scheduled moveOut.block job #${blockJobId} @ ${moveOutScheduledAt}${isFutureMoveOut ? ' (future)' : ' (today/past — worker will run asap)'}`,
        );
      }

      await transaction.commit();
      this.logger.log(
        `[unitSync] MSSQL synced — ${areaCode}:${showBoxNo} useState=${useState} isOverlocked=${isOverlocked} endTime=${endTime} accessCode=${accessCode}`,
      );

      savedAccessCode = accessCode;
    } catch (err) {
      await safeRollback(transaction);
      this.logger.error(
        `[unitSync] Transaction rolled back: ${(err as Error).message}`,
      );
      throw err;
    }

    // STG rental에 accessCode 기록 (트랜잭션 밖에서 — DB 커밋 후 STG 실패해도 롤백 안 함)
    await this.sgApi.updateUnitRental(rentalId, {
      customFields: { gate_code: savedAccessCode },
    });

    return { userName, stgUserId: ownerId };
  }

  /**
   * 렌탈이 없는 유닛 — MSSQL을 빈 유닛 상태로 리셋
   */
  private async syncEmpty(
    unitId: string,
    areaCode: string,
    showBoxNo: number,
  ): Promise<void> {
    const transaction = await this.db.beginTransaction();
    try {
      const currentBoxResult = await new sql.Request(transaction)
        .input('areaCode', sql.NVarChar, areaCode)
        .input('showBoxNo', sql.Int, showBoxNo)
        .query<{
          userPhone: string;
          userCode: string;
        }>(
          `SELECT ISNULL(userPhone, '') AS userPhone, ISNULL(userCode, '') AS userCode
           FROM tblBoxMaster
           WHERE areaCode = @areaCode AND showBoxNo = @showBoxNo`,
        );

      const currentBox = currentBoxResult.recordset[0];
      const currentUserPhone = normalizePhone(currentBox?.userPhone ?? '');
      const currentStgUserId = currentBox?.userCode || undefined;

      // tblBoxMaster 초기화
      await new sql.Request(transaction)
        .input('areaCode', sql.NVarChar, areaCode)
        .input('showBoxNo', sql.Int, showBoxNo).query(`
          UPDATE tblBoxMaster
          SET
            useState      = 2,
            userCode      = '',
            userName      = '',
            userPhone     = '',
            boxPassword   = '2580',
            useTimeType   = 0,
            startTime     = GETDATE(),
            endTime       = GETDATE(),
            deliveryType  = 0,
            isOverlocked  = 0,
            updateTime    = GETDATE()
          WHERE areaCode = @areaCode AND showBoxNo = @showBoxNo
        `);

      // History 스냅샷 (eventType=140: unit sync)
      await insertBoxHistorySnapshot(transaction, areaCode, showBoxNo, 140);

      if (currentUserPhone || currentStgUserId) {
        await deletePtiUserForUnit(
          transaction,
          areaCode,
          showBoxNo,
          currentUserPhone,
          currentStgUserId,
        );
      }

      // 빈 유닛이므로 pending 스케줄은 모두 무효 — cancel
      const cancelledSchedules =
        await this.scheduledJobRepo.cancelPendingForUnit(
          transaction,
          areaCode,
          showBoxNo,
          [
            ScheduledJobEventType.MoveInActivate,
            ScheduledJobEventType.MoveOutBlock,
          ],
          'Replaced by unit-sync reconcile (unit empty)',
        );
      if (cancelledSchedules > 0) {
        this.logger.log(
          `[unitSync] cancelled ${cancelledSchedules} pending schedule(s) — unit is empty`,
        );
      }

      await transaction.commit();
      this.logger.log(
        `[unitSync] MSSQL reset to empty — ${areaCode}:${showBoxNo}`,
      );
    } catch (err) {
      await safeRollback(transaction);
      this.logger.error(
        `[unitSync] Transaction rolled back: ${(err as Error).message}`,
      );
      throw err;
    }
  }
}

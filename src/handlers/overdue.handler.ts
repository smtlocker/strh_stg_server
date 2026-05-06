import { Injectable, Logger } from '@nestjs/common';
import { WebhookHandler } from './handler.interface';
import { WebhookPayloadDto } from '../webhook/dto/webhook-payload.dto';
import { DatabaseService } from '../database/database.service';
import { StoreganiseApiService } from '../storeganise/storeganise-api.service';
import { SyncMeta } from '../monitoring/monitoring.types';
import { resolveUnitMapping, extractUserInfo } from '../common/utils';
import {
  insertBoxHistorySnapshot,
  setPtiUserEnableAllForGroup,
  safeRollback,
} from '../common/db-utils';
import { StgEventType } from '../common/event-types';
import * as sql from 'mssql';

@Injectable()
export class OverdueHandler implements WebhookHandler {
  private readonly logger = new Logger(OverdueHandler.name);
  private static readonly OVERLOCK_ACTIVE = 'overlocked';
  private static readonly OVERLOCK_REMOVED = 'overlock removed';

  constructor(
    private readonly db: DatabaseService,
    private readonly sgApi: StoreganiseApiService,
  ) {}

  async handle(payload: WebhookPayloadDto): Promise<SyncMeta | void> {
    switch (payload.type) {
      case 'unitRental.markOverdue':
        return this.handleMarkOverdue(payload);
      case 'unitRental.unmarkOverdue':
        return this.handleUnmarkOverdue(payload);
      default:
        this.logger.warn(
          `OverdueHandler received unhandled event type: ${payload.type}`,
        );
    }
  }

  // Q13: C타입 일반 연체. useState=3만 변경, 나머지 유지. PTIUser Enable=0.
  private async handleMarkOverdue(
    payload: WebhookPayloadDto,
  ): Promise<SyncMeta | void> {
    const rentalId = payload.data?.unitRentalId;
    if (!rentalId) {
      const reason = 'missing unitRentalId in markOverdue payload';
      this.logger.warn(reason);
      return { softError: reason };
    }
    this.logger.log(`[markOverdue] Processing rentalId=${rentalId}`);

    const rental = await this.sgApi.getUnitRental(rentalId);
    const unitId = rental.unitId;
    const ownerId = rental.ownerId ?? '';

    const unit = await this.sgApi.getUnit(unitId);
    const parsed = await resolveUnitMapping(this.sgApi, unit);
    // user 는 필요한 순간에 재사용 — parse 실패 분기에서도 userName 을 대시보드에 남길 수 있도록
    // 여기서 먼저 조회한다. 실패 시 userName 없이 진행 (에러 대신 조용히 skip).
    let user;
    try {
      user = await this.sgApi.getUser(ownerId);
    } catch {
      user = undefined;
    }
    const { userPhone, userName } = user
      ? extractUserInfo(user)
      : { userPhone: '', userName: undefined };

    if (!parsed) {
      const reason = `smartcube_id missing or invalid for unitId ${unitId} (rentalId ${rentalId})`;
      this.logger.warn(`[markOverdue] ${reason} — skipping`);
      return {
        softError: reason,
        stgUserId: ownerId,
        stgUnitId: unitId,
        userName,
      };
    }
    const { areaCode, showBoxNo } = parsed;

    // STG 가 퇴거 완료 후 미납 invoice 의 past-due 전이로 markOverdue 를 다시 발사할 수
    // 있어, 'occupied' 가 아닌 rental 에 자동 오버락이 적용되지 않도록 가드한다.
    // (룰은 unit-sync.handler 의 isOccupiedRental 과 동일 — allow-list)
    const rentalState =
      typeof rental.state === 'string' ? rental.state.trim().toLowerCase() : '';
    if (rentalState !== 'occupied') {
      const reason = `rental state='${rentalState || 'missing'}' (not occupied) — auto-overlock skipped`;
      this.logger.log(
        `[markOverdue] ${reason} — rentalId=${rentalId} unitId=${unitId}`,
      );
      return {
        noopReason: reason,
        areaCode,
        showBoxNo,
        userName,
        stgUserId: ownerId,
        stgUnitId: unitId,
      };
    }

    const transaction = await this.db.beginTransaction();
    try {
      // DB 측 공실/사용자 매칭 가드 — STG 의 rental.state 가 'occupied' 라고 응답해도
      // 우리 DB 가 그 rental 의 unit 을 이미 비웠거나 다른 사용자 점유로 바뀐 경우엔
      // 자동 오버락을 박으면 안 된다. 박으면 그 isOverlocked=1 비트가 다음 사용자
      // 입주 시 blockerCheck 를 false-positive 로 hit 시켜 그룹 PTI 가 차단된다
      // (Park, Gyong jin 2026-05-04 케이스. 04-29 에 퇴거된 rental 에 05-01 markOverdue
      // 가 발사돼 1305 에 isOverlocked=1 잔존 → 05-04 신규 사용자 move-in 시 폭발).
      const dbState = await new sql.Request(transaction)
        .input('areaCode', sql.NVarChar, areaCode)
        .input('showBoxNo', sql.Int, showBoxNo)
        .query<{ useState: number; userCode: string }>(
          `SELECT ISNULL(useState, 0) AS useState, ISNULL(userCode, '') AS userCode
           FROM tblBoxMaster WHERE areaCode = @areaCode AND showBoxNo = @showBoxNo`,
        );
      const dbRow = dbState.recordset[0];
      if (!dbRow) {
        await safeRollback(transaction);
        const reason = `DB unit not found ${areaCode}:${showBoxNo} — auto-overlock skipped`;
        this.logger.warn(`[markOverdue] ${reason} — rentalId=${rentalId}`);
        return {
          noopReason: reason,
          areaCode,
          showBoxNo,
          userName,
          stgUserId: ownerId,
          stgUnitId: unitId,
        };
      }
      if (dbRow.useState === 2 || dbRow.userCode === '') {
        await safeRollback(transaction);
        // useState=2 는 명시 공실, userCode='' 는 점유 흔적은 있되 사용자 미할당
        // (이전 사이클의 잔류 / migration 미완료 등). 둘 다 markOverdue 의 대상이
        // 아니므로 skip 하되 라벨은 분기해 운영 가시성을 높인다.
        const reason =
          dbRow.useState === 2
            ? `DB unit vacant (useState=2) — auto-overlock skipped`
            : `DB userCode empty (useState=${dbRow.useState}) — auto-overlock skipped`;
        this.logger.log(`[markOverdue] ${reason} — rentalId=${rentalId}`);
        return {
          noopReason: reason,
          areaCode,
          showBoxNo,
          userName,
          stgUserId: ownerId,
          stgUnitId: unitId,
        };
      }
      if (dbRow.userCode !== ownerId) {
        await safeRollback(transaction);
        const reason = `DB userCode mismatch — rental ownerId=${ownerId} but DB userCode=${dbRow.userCode} — auto-overlock skipped`;
        this.logger.warn(`[markOverdue] ${reason} — rentalId=${rentalId}`);
        return {
          noopReason: reason,
          areaCode,
          showBoxNo,
          userName,
          stgUserId: ownerId,
          stgUnitId: unitId,
        };
      }

      // markOverdue: useState=3, isOverlocked=1 마킹
      // (scheduler worker가 어떠한 경우에도 락을 풀지 못하도록)
      await new sql.Request(transaction)
        .input('areaCode', sql.NVarChar, areaCode)
        .input('showBoxNo', sql.Int, showBoxNo)
        .query(
          `UPDATE tblBoxMaster SET useState = 3, isOverlocked = 1, updateTime = GETDATE()
           WHERE areaCode = @areaCode AND showBoxNo = @showBoxNo`,
        );

      // 같은 그룹 내 모든 PTI Enable=0 (게이트 차단)
      await setPtiUserEnableAllForGroup(transaction, areaCode, 0, ownerId);

      // tblBoxHistory 스냅샷 (Q4)
      await insertBoxHistorySnapshot(
        transaction,
        areaCode,
        showBoxNo,
        StgEventType.AutoOverlock,
      );

      await transaction.commit();
      this.logger.log(
        `[markOverdue] DB updated: areaCode=${areaCode} showBoxNo=${showBoxNo} phone=${userPhone}`,
      );
    } catch (err) {
      await safeRollback(transaction);
      this.logger.error(
        `[markOverdue] Transaction rolled back for rentalId=${rentalId}: ${(err as Error).message}`,
      );
      throw err;
    }

    await this.sgApi.updateUnitRental(rentalId, {
      customFields: {
        smartcube_lockStatus: OverdueHandler.OVERLOCK_ACTIVE,
        smartcube_lockUnit: false,
        smartcube_unlockUnit: false,
      },
    });
    this.logger.log(
      `[markOverdue] SG rental updated lockStatus=${OverdueHandler.OVERLOCK_ACTIVE} for rentalId=${rentalId}`,
    );

    return {
      areaCode,
      showBoxNo,
      userName,
      stgUserId: ownerId,
      stgUnitId: unitId,
    };
  }

  // Q13: useState=1만 변경. PTIUser Enable=1.
  private async handleUnmarkOverdue(
    payload: WebhookPayloadDto,
  ): Promise<SyncMeta | void> {
    const rentalId = payload.data?.unitRentalId;
    if (!rentalId) {
      const reason = 'missing unitRentalId in unmarkOverdue payload';
      this.logger.warn(reason);
      return { softError: reason };
    }
    this.logger.log(`[unmarkOverdue] Processing rentalId=${rentalId}`);

    const rental = await this.sgApi.getUnitRental(rentalId);
    const unitId = rental.unitId;
    const ownerId = rental.ownerId ?? '';

    const unit = await this.sgApi.getUnit(unitId);
    const parsed = await resolveUnitMapping(this.sgApi, unit);
    let user;
    try {
      user = await this.sgApi.getUser(ownerId);
    } catch {
      user = undefined;
    }
    const { userPhone, userName } = user
      ? extractUserInfo(user)
      : { userPhone: '', userName: undefined };

    if (!parsed) {
      const reason = `smartcube_id missing or invalid for unitId ${unitId} (rentalId ${rentalId})`;
      this.logger.warn(`[unmarkOverdue] ${reason} — skipping`);
      return {
        softError: reason,
        stgUserId: ownerId,
        stgUnitId: unitId,
        userName,
      };
    }
    const { areaCode, showBoxNo } = parsed;

    const transaction = await this.db.beginTransaction();
    try {
      // 유닛 차단 해제 (항상). overlock 플래그도 함께 clear.
      await new sql.Request(transaction)
        .input('areaCode', sql.NVarChar, areaCode)
        .input('showBoxNo', sql.Int, showBoxNo)
        .query(
          `UPDATE tblBoxMaster SET useState = 1, isOverlocked = 0, updateTime = GETDATE()
           WHERE areaCode = @areaCode AND showBoxNo = @showBoxNo`,
        );

      const overdueCheck = await new sql.Request(transaction)
        .input('areaCode', sql.NVarChar, areaCode)
        .input('stgUserId', sql.NVarChar, ownerId)
        .input('userPhone', sql.NVarChar, userPhone)
        .input('showBoxNo', sql.Int, showBoxNo)
        .query<{ cnt: number }>(
          `SELECT COUNT(*) AS cnt FROM tblBoxMaster
           WHERE areaCode = @areaCode
             AND userCode = @stgUserId
             AND isOverlocked = 1
             AND showBoxNo <> @showBoxNo`,
        );

      const otherOverdueCount = overdueCheck.recordset[0]?.cnt ?? 0;

      if (otherOverdueCount === 0) {
        await setPtiUserEnableAllForGroup(transaction, areaCode, 1, ownerId);
        this.logger.log(`[unmarkOverdue] Group PTI rows re-enabled`);
      } else {
        this.logger.log(
          `[unmarkOverdue] Other overdue units remain in group (${otherOverdueCount}) — gate PTI stays disabled`,
        );
      }

      await insertBoxHistorySnapshot(
        transaction,
        areaCode,
        showBoxNo,
        StgEventType.AutoUnlock,
      );

      await transaction.commit();
      this.logger.log(
        `[unmarkOverdue] Overlock removed for unit: areaCode=${areaCode} showBoxNo=${showBoxNo} phone=${userPhone}`,
      );
    } catch (err) {
      await safeRollback(transaction);
      this.logger.error(
        `[unmarkOverdue] Transaction rolled back for rentalId=${rentalId}: ${(err as Error).message}`,
      );
      throw err;
    }

    await this.sgApi.updateUnitRental(rentalId, {
      customFields: {
        smartcube_lockStatus: OverdueHandler.OVERLOCK_REMOVED,
        smartcube_lockUnit: false,
        smartcube_unlockUnit: false,
      },
    });
    this.logger.log(
      `[unmarkOverdue] SG rental updated lockStatus=${OverdueHandler.OVERLOCK_REMOVED} for rentalId=${rentalId}`,
    );

    return {
      areaCode,
      showBoxNo,
      userName,
      stgUserId: ownerId,
      stgUnitId: unitId,
    };
  }
}

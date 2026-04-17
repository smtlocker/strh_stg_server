import { Injectable, Logger } from '@nestjs/common';
import { WebhookHandler } from './handler.interface';
import { WebhookPayloadDto } from '../webhook/dto/webhook-payload.dto';
import { DatabaseService } from '../database/database.service';
import { StoreganiseApiService } from '../storeganise/storeganise-api.service';
import { SyncLogService } from '../monitoring/sync-log.service';
import { SyncMeta } from '../monitoring/monitoring.types';
import {
  resolveUnitMapping,
  extractUserInfo,
  findJobStep,
  formatKstDate,
} from '../common/utils';
import { getSyncLogContext } from '../common/sync-log-context';
import {
  insertBoxHistorySnapshot,
  relocatePtiUserToUnit,
  setPtiUserEnableAllForGroup,
  safeRollback,
} from '../common/db-utils';
import { executeMoveOutCompletion } from '../common/move-out-core';
import { StgEventType } from '../common/event-types';
import * as sql from 'mssql';

@Injectable()
export class TransferHandler implements WebhookHandler {
  private readonly logger = new Logger(TransferHandler.name);
  private static readonly ACCESS_CODE_SYNC_MAX_ATTEMPTS = 3;

  constructor(
    private readonly db: DatabaseService,
    private readonly sgApi: StoreganiseApiService,
    private readonly syncLog: SyncLogService,
  ) {}

  async handle(payload: WebhookPayloadDto): Promise<SyncMeta | void> {
    if (payload.type !== 'job.unit_transfer.completed') {
      this.logger.warn(
        `TransferHandler received unexpected event type: ${payload.type}`,
      );
      return;
    }
    return this.handleCompleted(payload);
  }

  private async handleCompleted(
    payload: WebhookPayloadDto,
  ): Promise<SyncMeta | void> {
    const jobId = payload.data?.jobId;
    if (!jobId) {
      const reason = 'missing jobId in transfer.completed payload';
      this.logger.warn(reason);
      return { softError: reason };
    }
    this.logger.log(`[transfer.completed] jobId=${jobId}`);

    // 1. Fetch job
    const job = await this.sgApi.getJob(jobId);
    const ownerId = job.ownerId ?? job.userId ?? '';
    const oldRentalId = job.data?.oldRentalId;
    const newUnitId = job.data?.newUnitId ?? job.data?.unitId;

    if (!oldRentalId || !newUnitId) {
      const reason = `Missing oldRentalId(${oldRentalId}) or newUnitId(${newUnitId}) in STG job ${jobId}`;
      this.logger.warn(`[transfer.completed] ${reason}. Skipping.`);
      return { softError: reason };
    }

    this.logger.log(
      `[transfer.completed] ownerId=${ownerId} oldRentalId=${oldRentalId} newUnitId=${newUnitId}`,
    );

    // 2. Fetch old rental → old unit
    const oldRental = await this.sgApi.getUnitRental(oldRentalId);
    const oldUnitId: string = oldRental.unitId;
    const oldUnit = await this.sgApi.getUnit(oldUnitId);
    const oldParsed = await resolveUnitMapping(this.sgApi, oldUnit);

    // 3. Fetch new unit
    const newUnit = await this.sgApi.getUnit(newUnitId);
    const newParsed = await resolveUnitMapping(this.sgApi, newUnit);

    if (!oldParsed || !newParsed) {
      const reason = `smartcube_id missing — old(${oldUnitId}): ${oldParsed ? 'OK' : 'N/A'}, new(${newUnitId}): ${newParsed ? 'OK' : 'N/A'}`;
      this.logger.warn(`[transfer.completed] ${reason}. Skipping.`);
      return { softError: reason, stgUnitId: newUnitId, stgUserId: ownerId };
    }

    const {
      areaCode: oldAreaCode,
      showBoxNo: oldShowBoxNo,
      officeCode: oldOfficeCode,
    } = oldParsed;
    const {
      areaCode: newAreaCode,
      showBoxNo: newShowBoxNo,
      officeCode: newOfficeCode,
    } = newParsed;

    if (oldOfficeCode !== newOfficeCode) {
      this.logger.warn(
        `[transfer.completed] Cross-office transfer is not supported — oldOffice=${oldOfficeCode} newOffice=${newOfficeCode}. Skipping.`,
      );
      return;
    }

    this.logger.log(
      `[transfer.completed] old: ${oldAreaCode}:${oldShowBoxNo} → new: ${newAreaCode}:${newShowBoxNo}`,
    );

    // 4. Fetch user info
    const user = await this.sgApi.getUser(ownerId);
    const { userPhone, userName } = extractUserInfo(user);

    // 5. Execute DB transaction (당일 즉시 이전만 지원)
    let accessCode: string | null = null;
    const transaction = await this.db.beginTransaction();
    try {
      // 5-1. 기존유닛 상태 조회 (초기화 전에 복사 — Q2 상태 승계)
      const oldBoxResult = await new sql.Request(transaction)
        .input('areaCode', sql.NVarChar, oldAreaCode)
        .input('showBoxNo', sql.Int, oldShowBoxNo)
        .query<{
          boxPassword: string;
          isOverlocked: number;
          endTime: string;
        }>(
          `SELECT boxPassword,
                  ISNULL(isOverlocked, 0) AS isOverlocked,
                  CONVERT(nvarchar(19), endTime, 120) AS endTime
           FROM tblBoxMaster
           WHERE areaCode = @areaCode AND showBoxNo = @showBoxNo`,
        );
      const oldBoxPassword = oldBoxResult.recordset[0]?.boxPassword ?? '2580';
      const inheritedOverlocked =
        oldBoxResult.recordset[0]?.isOverlocked === 1 ? 1 : 0;
      const inheritedEndTime =
        oldBoxResult.recordset[0]?.endTime ?? '2099-12-31 23:59:59';
      // Q2: 승계 상태가 차단(오버락)이면 신규 유닛도 useState=3 로 차단 유지,
      // 정상이면 useState=1. 게이트는 이후 setPtiUserEnableAllForGroup 에서 일관화.
      const inheritedUseState = inheritedOverlocked === 1 ? 3 : 1;

      // 5-2. 신규 유닛 존재 + 중복 입주 가드
      const newBoxCheck = await new sql.Request(transaction)
        .input('areaCode', sql.NVarChar, newAreaCode)
        .input('showBoxNo', sql.Int, newShowBoxNo)
        .query<{ useState: number; userCode: string }>(`
          SELECT ISNULL(useState, 0) AS useState, ISNULL(userCode, '') AS userCode
          FROM tblBoxMaster WHERE areaCode = @areaCode AND showBoxNo = @showBoxNo
        `);
      const newBoxRow = newBoxCheck.recordset[0];
      if (!newBoxRow) {
        await safeRollback(transaction);
        return {
          areaCode: newAreaCode, showBoxNo: newShowBoxNo, stgUserId: ownerId,
          softError: `Transfer target unit not found: ${newAreaCode}:${newShowBoxNo}`,
        };
      }
      const targetUserCode = newBoxRow.userCode;
      if (
        newBoxRow.useState === 1 &&
        targetUserCode &&
        targetUserCode !== ownerId &&
        /^[a-f0-9]{24}$/.test(targetUserCode)
      ) {
        await safeRollback(transaction);
        return {
          areaCode: newAreaCode, showBoxNo: newShowBoxNo, stgUserId: ownerId,
          softError: `Transfer target already occupied by ${targetUserCode}: ${newAreaCode}:${newShowBoxNo}`,
        };
      }

      // 신규유닛 배정 (즉시 활성, startTime=오늘00시, Q2 상태 승계)
      const req1 = new sql.Request(transaction);
      req1.input('userCode', sql.NVarChar, ownerId);
      req1.input('userName', sql.NVarChar, userName);
      req1.input('userPhone', sql.NVarChar, userPhone);
      req1.input('boxPassword', sql.NVarChar, oldBoxPassword);
      req1.input('areaCode', sql.NVarChar, newAreaCode);
      req1.input('showBoxNo', sql.Int, newShowBoxNo);
      req1.input('useState', sql.Int, inheritedUseState);
      req1.input('isOverlocked', sql.TinyInt, inheritedOverlocked);
      req1.input('endTime', sql.NVarChar, inheritedEndTime);
      await req1.query(`
        UPDATE tblBoxMaster
        SET
          useState      = @useState,
          userCode      = @userCode,
          userName      = @userName,
          userPhone     = @userPhone,
          boxPassword   = @boxPassword,
          startTime     = CAST(CAST(GETDATE() AS date) AS datetime),
          endTime       = @endTime,
          useTimeType   = 99,
          payType       = 1,
          deliveryType  = 1,
          isOverlocked  = @isOverlocked,
          updateTime    = GETDATE()
        WHERE areaCode = @areaCode AND showBoxNo = @showBoxNo
      `);
      await insertBoxHistorySnapshot(
        transaction,
        newAreaCode,
        newShowBoxNo,
        StgEventType.TransferIn,
      );

      // 5-3. 기존 PTI에서 accessCode 조회 (STG 역기록용)
      const ptiReq = new sql.Request(transaction)
        .input('oldAreaCode', sql.NVarChar, oldAreaCode)
        .input('oldShowBoxNo', sql.Int, oldShowBoxNo)
        .input('stgUserId', sql.NVarChar, ownerId)
        .input('userPhone', sql.NVarChar, userPhone);
      const ptiResult = await ptiReq.query<{ AccessCode: string }>(`
          SELECT TOP 1 AccessCode
          FROM tblPTIUserInfo
          WHERE AreaCode = @oldAreaCode
            AND showBoxNo = @oldShowBoxNo
            AND StgUserId = @stgUserId
        `);
      accessCode = ptiResult.recordset[0]?.AccessCode ?? null;

      // 5-4. PTI: 기존 유닛에서 신규 유닛으로 유닛 ID만 변경
      await relocatePtiUserToUnit(transaction, {
        oldAreaCode,
        oldShowBoxNo,
        newAreaCode,
        newShowBoxNo,
        stgUserId: ownerId,
      });

      // 5-5. Q2/Q8: 승계된 상태에 따라 group 전체 PTI 일관화
      const ptiEnable: 0 | 1 = inheritedOverlocked === 1 ? 0 : 1;
      await setPtiUserEnableAllForGroup(
        transaction,
        newAreaCode,
        ptiEnable,
        ownerId,
      );
      this.logger.log(
        `[transfer.completed] Group PTI set to Enable=${ptiEnable} (inheritedOverlocked=${inheritedOverlocked})`,
      );

      // 5-6. 기존유닛 full reset — transfer 경로이므로 TransferOut eventType 사용
      await executeMoveOutCompletion(
        transaction,
        oldAreaCode,
        oldShowBoxNo,
        this.logger,
        ownerId,
        inheritedOverlocked === 1, // wasOverlocked: 기존 유닛이 오버락이었으면 기존 그룹 Q7 복구 trigger
        StgEventType.TransferOut,
      );

      await transaction.commit();
      this.logger.log(
        `[transfer.completed] Transaction committed: ${oldAreaCode}:${oldShowBoxNo} → ${newAreaCode}:${newShowBoxNo}`,
      );
    } catch (err) {
      await safeRollback(transaction);
      this.logger.error(
        `[transfer.completed] Transaction rolled back: ${(err as Error).message}`,
        (err as Error).stack,
      );
      throw err;
    }

    // 6. STG 신규 rental 업데이트 (startDate=오늘 + accessCode 역기록)
    const startStep = findJobStep(job, 'start');
    const newUnitRentalId =
      startStep?.result?.unitRentalId ??
      job.data?.unitRentalId ??
      job.data?.newRentalId;
    if (newUnitRentalId) {
      const today = formatKstDate(new Date());
      const updateBody: Record<string, unknown> = { startDate: today };
      if (accessCode) {
        updateBody.customFields = { gate_code: accessCode };
      }
      await this.syncRentalToStg({
        jobId,
        rentalId: newUnitRentalId,
        updateBody,
        areaCode: newAreaCode,
        showBoxNo: newShowBoxNo,
        userName,
        stgUserId: ownerId,
        stgUnitId: newUnitId,
      });
    }

    return {
      areaCode: newAreaCode,
      showBoxNo: newShowBoxNo,
      userName,
      stgUserId: ownerId,
      stgUnitId: newUnitId,
    };
  }

  private async syncRentalToStg(params: {
    jobId: string;
    rentalId: string;
    updateBody: Record<string, unknown>;
    areaCode: string;
    showBoxNo: number;
    userName: string;
    stgUserId: string;
    stgUnitId: string;
  }): Promise<void> {
    let lastError: Error | null = null;

    for (
      let attempt = 1;
      attempt <= TransferHandler.ACCESS_CODE_SYNC_MAX_ATTEMPTS;
      attempt += 1
    ) {
      try {
        await this.sgApi.updateUnitRental(params.rentalId, params.updateBody);
        this.logger.log(
          `[transfer.completed] SG rental updated — rentalId=${params.rentalId} attempt=${attempt}`,
        );
        return;
      } catch (err) {
        lastError = err as Error;
        this.logger.warn(
          `[transfer.completed] Failed to sync rental to SG — rentalId=${params.rentalId} attempt=${attempt}: ${lastError.message}`,
        );
        if (attempt < TransferHandler.ACCESS_CODE_SYNC_MAX_ATTEMPTS) {
          getSyncLogContext()?.recordRetry({
            error: `[transfer.rentalSync] ${lastError.message}`,
            attempt,
            maxAttempts: TransferHandler.ACCESS_CODE_SYNC_MAX_ATTEMPTS,
            extra: {
              source: 'transfer-rental-sync',
              jobId: params.jobId,
              rentalId: params.rentalId,
            },
          });
        }
      }
    }

    await this.syncLog.add({
      source: 'webhook',
      eventType: 'job.unit_transfer.rentalSync',
      eventId: null,
      businessCode: null,
      areaCode: params.areaCode,
      showBoxNo: params.showBoxNo,
      userName: params.userName,
      stgUserId: params.stgUserId,
      stgUnitId: params.stgUnitId,
      status: 'error',
      durationMs: 0,
      error: lastError?.message ?? 'Unknown rental sync failure',
      payload: {
        jobId: params.jobId,
        rentalId: params.rentalId,
        updateBody: params.updateBody,
      },
    });
  }
}

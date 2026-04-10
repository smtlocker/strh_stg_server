import { Injectable, Logger } from '@nestjs/common';
import { WebhookHandler } from './handler.interface';
import { WebhookPayloadDto } from '../webhook/dto/webhook-payload.dto';
import { DatabaseService } from '../database/database.service';
import { StoreganiseApiService } from '../storeganise/storeganise-api.service';
import {
  resolveUnitMapping,
  extractUserInfo,
  findJobStep,
} from '../common/utils';
import {
  insertBoxHistorySnapshot,
  findExistingAccessCode,
  generateUniqueAccessCode,
  upsertPtiUserForUnit,
  setPtiUserEnableAllForGroup,
  safeRollback,
} from '../common/db-utils';
import { SyncMeta } from '../monitoring/monitoring.types';
import { ScheduledJobRepository } from '../scheduler/scheduled-job.repository';
import { ScheduledJobEventType } from '../scheduler/scheduled-job.types';
import * as sql from 'mssql';

@Injectable()
export class MoveInHandler implements WebhookHandler {
  private readonly logger = new Logger(MoveInHandler.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly sgApi: StoreganiseApiService,
    private readonly scheduledJobRepo: ScheduledJobRepository,
  ) {}

  async handle(payload: WebhookPayloadDto): Promise<SyncMeta | void> {
    switch (payload.type) {
      case 'job.unit_moveIn.completed':
        return this.handleCompleted(payload);
      default:
        this.logger.warn(
          `MoveInHandler: unrecognised event type "${payload.type}"`,
        );
    }
  }

  // ---------------------------------------------------------------------------
  // job.unit_moveIn.completed  (Q8, Q9, Q11, Q19)
  // ---------------------------------------------------------------------------
  private async handleCompleted(
    payload: WebhookPayloadDto,
  ): Promise<SyncMeta | void> {
    const jobId = payload.data?.jobId;
    if (!jobId) {
      const reason = 'missing jobId in payload';
      this.logger.warn(`[moveIn.completed] ${reason}`);
      return { softError: reason };
    }
    const totalStart = Date.now();
    this.logger.log(`[moveIn.completed] jobId=${jobId}`);

    // 1. Fetch job data. STG의 unit_moveIn job은 할당된 unit을 다음 경로에 담는다:
    //    - job.result.unitId        ← 최종 결과 (가장 권위 있음)
    //    - job.steps['start'].result.unitId  ← start step 완료 직후
    //    - job.data.unitId          ← 일부 구 job 포맷 (fallback)
    // 과거 코드는 job.data.unitId만 봐서 대부분 케이스에서 unitId=''가 되어
    // 이후 resolveUnitMapping이 실패하는 silent skip 버그가 있었다.
    const stgFetchStart = Date.now();
    const job = await this.sgApi.getJob(jobId);
    const startStep = findJobStep(job, 'start');
    const unitId =
      job.result?.unitId ?? startStep?.result?.unitId ?? job.data?.unitId ?? '';
    const ownerId = job.ownerId ?? job.userId ?? '';
    const startDate = job.data?.startDate;
    const unitRentalId =
      startStep?.result?.unitRentalId ?? job.data?.unitRentalId ?? '';

    this.logger.log(
      `[moveIn.completed] unitId=${unitId} ownerId=${ownerId} unitRentalId=${unitRentalId}`,
    );

    if (!unitId) {
      const reason = `unitId missing in STG job ${jobId} — checked job.result.unitId / steps[start].result.unitId / data.unitId`;
      this.logger.warn(`[moveIn.completed] ${reason}`);
      return { softError: reason };
    }

    // 2. Fetch unit for smartcube_id → areaCode 복원
    const unit = await this.sgApi.getUnit(unitId);
    const parsed = await resolveUnitMapping(this.sgApi, unit);
    if (!parsed) {
      const reason = `smartcube_id not found or invalid for unitId=${unitId}`;
      this.logger.warn(`[moveIn.completed] ${reason}. Skipping.`);
      return { softError: reason, stgUnitId: unitId };
    }

    const { areaCode, showBoxNo, officeCode } = parsed;

    // 3. Fetch user info
    const user = await this.sgApi.getUser(ownerId);
    const { userPhone, userName } = extractUserInfo(user);
    const stgFetchMs = Date.now() - stgFetchStart;

    this.logger.log(
      `[moveIn.completed] userName=${userName} userPhone=${userPhone} areaCode=${areaCode} showBoxNo=${showBoxNo} (STG fetch: ${stgFetchMs}ms)`,
    );

    // 4. Execute DB transaction
    const dbStart = Date.now();
    let accessCode: string;
    let accessCodeGenerated: boolean;

    const transaction = await this.db.beginTransaction();
    try {
      // 4-1. 신규/기존 고객 확인 → AccessCode 결정 (Q8)
      const existingAccessCode = await findExistingAccessCode(
        transaction,
        officeCode,
        userPhone,
        ownerId,
      );
      accessCodeGenerated = !existingAccessCode;
      accessCode =
        existingAccessCode ??
        (await generateUniqueAccessCode(transaction, officeCode));

      this.logger.log(
        `[moveIn.completed] accessCode=${accessCode} (generated=${accessCodeGenerated}, existing=${!!existingAccessCode})`,
      );

      // 4-2. 유닛 존재 + 중복 입주 가드
      const boxCheck = await new sql.Request(transaction)
        .input('areaCode', sql.NVarChar, areaCode)
        .input('showBoxNo', sql.Int, showBoxNo)
        .query<{ useState: number; userCode: string }>(`
          SELECT ISNULL(useState, 0) AS useState, ISNULL(userCode, '') AS userCode
          FROM tblBoxMaster WHERE areaCode = @areaCode AND showBoxNo = @showBoxNo
        `);
      const existingRow = boxCheck.recordset[0];
      if (!existingRow) {
        await safeRollback(transaction);
        return {
          areaCode, showBoxNo, stgUserId: ownerId,
          softError: `Unit not found in DB: ${areaCode}:${showBoxNo} — smartcube_id 매핑 오류 가능`,
        };
      }
      // 중복 입주 가드: stgUserId 형태(24자 hex)의 다른 사용자가 입주 중일 때만 차단.
      // 기존 호호락 데이터(전화번호 형태 userCode)는 STG 전환 과정에서 덮어쓰기 허용.
      const existingUserCode = existingRow.userCode;
      if (
        existingRow.useState === 1 &&
        existingUserCode &&
        existingUserCode !== ownerId &&
        /^[a-f0-9]{24}$/.test(existingUserCode)
      ) {
        await safeRollback(transaction);
        return {
          areaCode, showBoxNo, stgUserId: ownerId,
          softError: `Unit already occupied by ${existingUserCode}: ${areaCode}:${showBoxNo}`,
        };
      }

      // UPDATE tblBoxMaster — startDate가 오늘 이하면 즉시 활성화, 미래면 차단
      const startTime = startDate ? `${startDate} 00:00:00` : null;
      const isImmediate =
        !startDate || new Date(`${startDate}T00:00:00`) <= new Date();
      const useState = isImmediate ? 1 : 3;

      const req1 = new sql.Request(transaction);
      req1.input('userCode', sql.NVarChar, ownerId);
      req1.input('userName', sql.NVarChar, userName);
      req1.input('userPhone', sql.NVarChar, userPhone);
      req1.input('areaCode', sql.NVarChar, areaCode);
      req1.input('showBoxNo', sql.Int, showBoxNo);
      req1.input('useState', sql.Int, useState);
      req1.input('startTime', sql.NVarChar, startTime);
      await req1.query(`
        UPDATE tblBoxMaster
        SET
          useState      = @useState,
          userCode      = @userCode,
          userName      = @userName,
          userPhone     = @userPhone,
          boxPassword   = '2580',
          startTime     = ${startTime ? '@startTime' : 'GETDATE()'},
          endTime       = '2099-12-31 23:59:59',
          useTimeType   = 99,
          payType       = 1,
          deliveryType  = 1,
          updateTime    = GETDATE()
        WHERE areaCode = @areaCode AND showBoxNo = @showBoxNo
      `);
      this.logger.log(
        `[moveIn.completed] tblBoxMaster updated for areaCode=${areaCode} showBoxNo=${showBoxNo}`,
      );

      // 4-3. tblPTIUserInfo — 지점에 PTI 없으면 INSERT, 있으면 스킵
      // 즉시 입주라도 같은 지점에 연체 유닛이 있으면 게이트 차단
      // 4-3. tblPTIUserInfo — 해당 유닛 PTI row upsert (미래 입주는 Enable=0)
      const unitEnable: 0 | 1 = isImmediate ? 1 : 0;
      await upsertPtiUserForUnit(transaction, {
        areaCode,
        showBoxNo,
        userPhone,
        userName,
        accessCode,
        enable: unitEnable,
        stgUserId: ownerId,
      });
      this.logger.log(
        `[moveIn.completed] tblPTIUserInfo upserted — accessCode=${accessCode} areaCode=${areaCode} showBoxNo synced`,
      );

      // 그룹 전체 PTI 일관화 — blocker(isOverlocked=1) 존재 여부 기반으로 결정
      // 미래 입주 PTI row 의 Enable=0 은 "아직 활성 안 됨" 이지 "차단" 이 아니므로
      // 그룹 내 다른 활성 유닛의 Enable 을 덮어쓰면 안 됨.
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

      if (hasBlocker) {
        // blocker 있으면 그룹 전체 Enable=0 (방금 upsert 한 row 포함)
        await setPtiUserEnableAllForGroup(
          transaction,
          areaCode,
          userPhone,
          0,
          ownerId,
        );
        this.logger.log(
          `[moveIn.completed] Overlocked unit exists in group — gate stays blocked`,
        );
      } else if (isImmediate) {
        // 즉시 입주 + blocker 없음 → 그룹 전체 Enable=1
        await setPtiUserEnableAllForGroup(
          transaction,
          areaCode,
          userPhone,
          1,
          ownerId,
        );
        this.logger.log(
          `[moveIn.completed] Group-wide PTI enabled (Enable=1)`,
        );
      }
      // 미래 입주 + blocker 없음 → 그룹 전체는 건드리지 않음
      // (다른 활성 유닛의 Enable=1 유지, 방금 upsert 한 row 만 Enable=0)

      // 4-4. INSERT tblBoxHistory — 30컬럼 스냅샷 (Q4)
      await insertBoxHistorySnapshot(transaction, areaCode, showBoxNo, 134);
      this.logger.log(
        `[moveIn.completed] tblBoxHistory snapshot inserted (eventType=134)`,
      );

      // 4-4-1. 이전 사이클의 stale 한 moveOut 관련 pending 스케줄 cleanup.
      // 새 임대가 시작된다는 것은 이전 임대 사이클이 완전히 종료됐다는 뜻이므로,
      // 남아있는 moveOut.block job은 실행되어선 안 된다.
      // (isOverlocked=1 인 상태에서 stale moveOut.block 스케줄이 stuck 되는 것 방지)
      // moveOut.resetComplete 는 즉시 reset 정책 도입 후 enum에서 제거됨.
      const cancelledStale = await this.scheduledJobRepo.cancelPendingForUnit(
        transaction,
        areaCode,
        showBoxNo,
        [ScheduledJobEventType.MoveOutBlock],
        'Superseded by new moveIn.completed',
      );
      if (cancelledStale > 0) {
        this.logger.log(
          `[moveIn.completed] Cancelled ${cancelledStale} stale moveOut schedule(s) from previous cycle — areaCode=${areaCode} showBoxNo=${showBoxNo}`,
        );
      }

      // 4-5. 미래 startDate → 스케줄러가 자동 활성화하도록 job 등록
      if (!isImmediate && startTime) {
        const jobIdScheduled = await this.scheduledJobRepo.create(transaction, {
          eventType: ScheduledJobEventType.MoveInActivate,
          scheduledAt: new Date(startTime),
          areaCode,
          showBoxNo,
          userPhone,
          userCode: ownerId,
          userName,
          sourceEventType: payload.type,
          sourceEventId: jobId,
          correlationKey: `webhook:${payload.type}:${jobId}`,
        });
        this.logger.log(
          `[moveIn.completed] scheduled moveIn.activate job #${jobIdScheduled} @ ${startTime}`,
        );
      }

      await transaction.commit();

      const dbMs = Date.now() - dbStart;
      this.logger.log(
        `[moveIn.completed] Transaction committed for areaCode=${areaCode} showBoxNo=${showBoxNo} (blocked until ${startDate ?? 'now'}) (DB: ${dbMs}ms)`,
      );
    } catch (err) {
      await safeRollback(transaction);
      this.logger.error(
        `[moveIn.completed] Transaction rolled back. Error: ${(err as Error).message}`,
        (err as Error).stack,
      );
      throw err;
    }

    // 5. Update SG rental with access code (신규/기존 모두 STG에 기록)
    const stgWriteStart = Date.now();
    await this.sgApi.updateUnitRental(unitRentalId, {
      customFields: { gate_code: accessCode },
    });
    const stgWriteMs = Date.now() - stgWriteStart;
    const totalMs = Date.now() - totalStart;

    this.logger.log(
      `[moveIn.completed] ✓ Complete — STG fetch: ${stgFetchMs}ms, DB: ${Date.now() - dbStart - stgWriteMs}ms, STG write: ${stgWriteMs}ms, Total: ${totalMs}ms`,
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

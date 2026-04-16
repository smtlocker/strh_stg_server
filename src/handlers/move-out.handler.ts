import { Injectable, Logger } from '@nestjs/common';
import { WebhookHandler } from './handler.interface';
import { WebhookPayloadDto } from '../webhook/dto/webhook-payload.dto';
import { DatabaseService } from '../database/database.service';
import { StoreganiseApiService } from '../storeganise/storeganise-api.service';
import { SyncMeta } from '../monitoring/monitoring.types';
import {
  resolveUnitMapping,
  findJobStep,
  extractUserInfo,
} from '../common/utils';
import {
  insertBoxHistorySnapshot,
  setPtiUserEnableAllForGroup,
  safeRollback,
} from '../common/db-utils';
import { executeMoveOutCompletion } from '../common/move-out-core';
import { StgEventType } from '../common/event-types';
import { ScheduledJobRepository } from '../scheduler/scheduled-job.repository';
import { ScheduledJobEventType } from '../scheduler/scheduled-job.types';
import * as sql from 'mssql';

@Injectable()
export class MoveOutHandler implements WebhookHandler {
  private readonly logger = new Logger(MoveOutHandler.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly sgApi: StoreganiseApiService,
    private readonly scheduledJobRepo: ScheduledJobRepository,
  ) {}

  async handle(payload: WebhookPayloadDto): Promise<SyncMeta | void> {
    switch (payload.type) {
      case 'job.unit_moveOut.created':
        return this.handleCreated(payload);
      case 'job.unit_moveOut.completed':
        return this.handleCompleted(payload);
      case 'job.unit_moveOut.cancelled':
        return this.handleCancelled(payload);
      default:
        this.logger.warn(
          `MoveOutHandler received unexpected event type: ${payload.type}`,
        );
    }
  }

  // moveOut.created: 퇴거 예약 시 endTime 설정 + 오늘이면 즉시 차단
  private async handleCreated(
    payload: WebhookPayloadDto,
  ): Promise<SyncMeta | void> {
    const jobId = payload.data?.jobId;
    if (!jobId) {
      const reason = 'missing jobId in moveOut.created payload';
      this.logger.warn(reason);
      return { softError: reason };
    }
    const totalStart = Date.now();
    this.logger.log(`MoveOut reservation created — jobId: ${jobId}`);

    const stgFetchStart = Date.now();
    const job = await this.sgApi.getJob(jobId);
    // move-in.handler와 동일한 이유로 unitId는 result → step.result → data 순 fallback
    const startStep = findJobStep(job, 'start');
    const unitId =
      job.result?.unitId ?? startStep?.result?.unitId ?? job.data?.unitId ?? '';
    const moveOutDate = job.data?.date ?? job.data?.moveOutDate;

    if (!moveOutDate) {
      const reason = `no moveOutDate in STG job ${jobId}`;
      this.logger.warn(`MoveOut.created: ${reason} — skipping endTime update`);
      return { softError: reason };
    }
    if (!unitId) {
      const reason = `unitId missing in STG job ${jobId}`;
      this.logger.warn(`MoveOut.created: ${reason} — skipping`);
      return { softError: reason };
    }

    const unit = await this.sgApi.getUnit(unitId);
    const parsed = await resolveUnitMapping(this.sgApi, unit);
    if (!parsed) {
      const reason = `smartcube_id missing for unit ${unitId}`;
      this.logger.warn(`MoveOut.created: ${reason} — skipping`);
      return { softError: reason, stgUnitId: unitId };
    }
    const { areaCode, showBoxNo } = parsed;
    const stgFetchMs = Date.now() - stgFetchStart;

    // endTime을 퇴거 예정일 23:59:59로 설정
    const endTime = `${moveOutDate} 23:59:59`;

    const dbStart = Date.now();
    let stgUserId = '';
    let userName = '';
    const transaction = await this.db.beginTransaction();
    try {
      // 현재 유닛 상태 조회
      const unitResult = await new sql.Request(transaction)
        .input('areaCode', sql.NVarChar, areaCode)
        .input('showBoxNo', sql.Int, showBoxNo)
        .query<{
          userPhone: string;
          userCode: string;
          userName: string;
        }>(`SELECT userPhone, userCode, userName FROM tblBoxMaster WHERE areaCode = @areaCode AND showBoxNo = @showBoxNo`);

      if (!unitResult.recordset[0]) {
        this.logger.warn(
          `MoveOut.created: unit not found — areaCode=${areaCode} showBoxNo=${showBoxNo}`,
        );
        await safeRollback(transaction);
        return;
      }

      const { userPhone } = unitResult.recordset[0];
      stgUserId = unitResult.recordset[0].userCode ?? '';
      userName = unitResult.recordset[0].userName ?? '';

      // Q6: 핸들러에서 useState 건드리지 않음 — endTime 갱신 + 스케줄 등록만.
      // worker 가 endDate 23:59:59 에 차단. 과거 날짜는 worker 다음 tick 에서 즉시 처리.
      await new sql.Request(transaction)
        .input('areaCode', sql.NVarChar, areaCode)
        .input('showBoxNo', sql.Int, showBoxNo)
        .input('endTime', sql.NVarChar, endTime)
        .query(
          `UPDATE tblBoxMaster SET endTime = @endTime, updateTime = GETDATE() WHERE areaCode = @areaCode AND showBoxNo = @showBoxNo`,
        );
      // endTime 만 예약 변경 (아직 반납 전)
      await insertBoxHistorySnapshot(
        transaction,
        areaCode,
        showBoxNo,
        StgEventType.MoveoutReserve,
      );
      this.logger.log(
        `MoveOut.created: endTime set (worker will block at ${endTime}) — areaCode=${areaCode} showBoxNo=${showBoxNo}`,
      );

      // tblBoxMaster 가 stale (수동 DB 수정, 장애 복구, 초기 동기화 누락 등)하여
      // user 정보가 비어 있는 경우 STG rental → user 를 조회하여 fallback.
      // 이 보완값은 (1) scheduledJob insert 의 userCode/userName (대시보드 표시),
      // (2) 마지막에 return 하는 SyncMeta 의 user 필드 모두에 사용된다.
      // 정상 운영에서 DB 가 동기화돼 있으면 fetch 는 호출되지 않는다.
      // 주의: fallback fetch 는 트랜잭션 안에서 수행되므로 tx 시간이 늘어날 수 있지만
      // (a) stale 인 경우에만 발생 (rare), (b) scheduledJob insert 와 SyncMeta 양쪽에서
      // 동일한 보완값을 쓰려면 insert 전에 resolve 돼야 함.
      if (!stgUserId || !userName) {
        const unitRentalId = payload.data?.unitRentalId;
        if (unitRentalId) {
          try {
            const rental = await this.sgApi.getUnitRental(unitRentalId);
            const rentalOwnerId = rental.ownerId ?? '';
            if (!stgUserId && rentalOwnerId) stgUserId = rentalOwnerId;
            if (!userName && rentalOwnerId) {
              const user = await this.sgApi.getUser(rentalOwnerId);
              userName = extractUserInfo(user).userName;
            }
            this.logger.debug(
              `MoveOut.created: user meta filled from STG rental fallback — stgUserId=${stgUserId} userName=${userName}`,
            );
          } catch (err) {
            this.logger.warn(
              `MoveOut.created: STG rental fallback failed for ${unitRentalId} — ${(err as Error).message}`,
            );
          }
        }
      }

      // 공통: moveOut.block 스케줄 등록 (immediate/future 모두)
      const blockJobId = await this.scheduledJobRepo.create(transaction, {
        eventType: ScheduledJobEventType.MoveOutBlock,
        scheduledAt: new Date(endTime),
        areaCode,
        showBoxNo,
        userPhone,
        userCode: stgUserId,
        userName,
        sourceEventType: payload.type,
        sourceEventId: jobId,
        correlationKey: `webhook:${payload.type}:${jobId}`,
      });
      this.logger.log(
        `MoveOut.created: scheduled moveOut.block job #${blockJobId} @ ${endTime}`,
      );

      await transaction.commit();
      const dbMs = Date.now() - dbStart;

      const totalMs = Date.now() - totalStart;
      this.logger.log(
        `MoveOut.created: ✓ Complete — STG fetch: ${stgFetchMs}ms, DB: ${dbMs}ms, Total: ${totalMs}ms — endTime=${endTime} (scheduled) — areaCode=${areaCode} showBoxNo=${showBoxNo}`,
      );
    } catch (err) {
      await transaction.rollback();
      this.logger.error(
        `MoveOut.created: transaction rolled back — ${(err as Error).message}`,
      );
      throw err;
    }

    return { areaCode, showBoxNo, userName, stgUserId, stgUnitId: unitId };
  }

  // moveOut.completed: 당일까지 접근 허용, 23:59:59 스케줄러가 초기화
  private async handleCompleted(
    payload: WebhookPayloadDto,
  ): Promise<SyncMeta | void> {
    const jobId = payload.data?.jobId;
    if (!jobId) {
      const reason = 'missing jobId in moveOut.completed payload';
      this.logger.warn(reason);
      return { softError: reason };
    }
    this.logger.log(`MoveOut completed — jobId: ${jobId}`);

    // 1. Fetch job details (unitId는 result → step.result → data 순)
    const job = await this.sgApi.getJob(jobId);
    const startStep = findJobStep(job, 'start');
    const unitId =
      job.result?.unitId ?? startStep?.result?.unitId ?? job.data?.unitId ?? '';
    // STG REST API로 생성된 job은 job.ownerId가 API key user를 가리키지만,
    // job.result.ownerId는 항상 rental의 실제 owner이다. UI 흐름에서는 둘이
    // 같으므로 result.ownerId를 우선적으로 채택한다.
    const ownerId = job.result?.ownerId ?? job.ownerId ?? job.userId ?? '';
    this.logger.debug(`Job fetched — unitId: ${unitId}, ownerId: ${ownerId}`);

    if (!unitId) {
      const reason = `unitId missing in STG job ${jobId}`;
      this.logger.warn(`MoveOut.completed: ${reason} — skipping`);
      return { softError: reason };
    }

    // 2. Fetch unit for smartcube_id → areaCode
    const unit = await this.sgApi.getUnit(unitId);
    const parsed = await resolveUnitMapping(this.sgApi, unit);
    if (!parsed) {
      const reason = `smartcube_id missing or invalid for unitId ${unitId}`;
      this.logger.warn(`MoveOut.completed: ${reason} — skipping`);
      return { softError: reason, stgUnitId: unitId };
    }
    const { areaCode, showBoxNo } = parsed;

    // 3. Fetch user for userName (SyncMeta용)
    const user = await this.sgApi.getUser(ownerId);
    const { userName } = extractUserInfo(user);

    // 4. **즉시 리셋 정책**: moveOut.completed 웹훅을 받는 즉시 유닛을 빈 상태로
    //    되돌리고 사용자 정보를 비운다. 과거에는 "당일 접근 허용 + KST 23:59:59에
    //    스케줄러 reset" 방식이었으나, "퇴거하면 즉시 비워야 한다"는 정책 변경에
    //    따라 스케줄링 단계를 제거하고 핸들러 안에서 곧장 reset을 수행한다.
    const transaction = await this.db.beginTransaction();
    try {
      // 4-1. 현재 상태 조회 — overlock 가드용 (admin이 수동 잠근 유닛은 자동
      //      reset이 락을 풀어버리지 않도록 skip)
      const unitResult = await new sql.Request(transaction)
        .input('areaCode', sql.NVarChar, areaCode)
        .input('showBoxNo', sql.Int, showBoxNo)
        .query<{ isOverlocked: number; userPhone: string }>(
          `SELECT ISNULL(isOverlocked, 0) AS isOverlocked,
                  ISNULL(userPhone, '') AS userPhone
           FROM tblBoxMaster
           WHERE areaCode = @areaCode AND showBoxNo = @showBoxNo`,
        );

      const row = unitResult.recordset[0];
      if (!row) {
        this.logger.warn(
          `MoveOut.completed: unit not found — areaCode=${areaCode} showBoxNo=${showBoxNo}`,
        );
        await safeRollback(transaction);
        return {
          softError: 'unit not found in tblBoxMaster',
          areaCode,
          showBoxNo,
          stgUserId: ownerId,
          stgUnitId: unitId,
          userName,
        };
      }

      // 4-2. 동일 유닛의 pending 스케줄을 모두 cancel.
      //      moveOut.completed 는 rental 사이클 자체가 끝났다는 의미이므로
      //      MoveOutBlock(미래 차단) + MoveInActivate(미래 입주 활성화) 모두
      //      더 이상 유효하지 않다. MoveInActivate 를 남기면 worker 가 나중에
      //      skip 처리하긴 하지만 운영 가시성이 나빠지므로 여기서 정리한다.
      //      (주의: moveOut.cancelled 는 rental 이 살아있는 상태로 되돌림이므로
      //       MoveInActivate 를 cancel 하지 않는 반면, moveOut.completed 는 cancel 한다)
      const cancelledCount = await this.scheduledJobRepo.cancelPendingForUnit(
        transaction,
        areaCode,
        showBoxNo,
        [
          ScheduledJobEventType.MoveOutBlock,
          ScheduledJobEventType.MoveInActivate,
        ],
        'Superseded by moveOut.completed (rental cycle ended)',
      );
      if (cancelledCount > 0) {
        this.logger.log(
          `MoveOut.completed: cancelled ${cancelledCount} pending schedule(s) — areaCode=${areaCode} showBoxNo=${showBoxNo}`,
        );
      }

      // 4-3. 즉시 리셋 — 공통 로직 호출.
      //      tblBoxMaster (useState=2, user 비움, boxPassword 기본값) +
      //      tblBoxHistory(135) + tblPTIUserInfo 삭제까지 한 번에 처리.
      const userPhone = row.userPhone || '';
      const wasOverlocked = row.isOverlocked === 1;
      await executeMoveOutCompletion(
        transaction,
        areaCode,
        showBoxNo,
        userPhone,
        this.logger,
        ownerId,
        wasOverlocked,
      );

      await transaction.commit();
      this.logger.log(
        `MoveOut.completed: ✓ unit reset (immediate) — areaCode=${areaCode} showBoxNo=${showBoxNo}`,
      );
    } catch (err) {
      await transaction.rollback();
      this.logger.error(
        `MoveOut.completed: transaction rolled back — ${(err as Error).message}`,
      );
      throw err;
    }

    return {
      areaCode,
      showBoxNo,
      userName,
      stgUserId: ownerId,
      stgUnitId: unitId,
    };
  }

  // moveOut.cancelled: 퇴거 취소 시 endTime 복원 + moveOut 차단 해제
  private async handleCancelled(
    payload: WebhookPayloadDto,
  ): Promise<SyncMeta | void> {
    const jobId = payload.data?.jobId;
    if (!jobId) {
      const reason = 'missing jobId in moveOut.cancelled payload';
      this.logger.warn(reason);
      return { softError: reason };
    }
    const totalStart = Date.now();
    this.logger.log(`MoveOut cancelled — jobId: ${jobId}`);

    const stgFetchStart = Date.now();
    const job = await this.sgApi.getJob(jobId);
    const startStep = findJobStep(job, 'start');
    const unitId =
      job.result?.unitId ?? startStep?.result?.unitId ?? job.data?.unitId ?? '';

    if (!unitId) {
      const reason = `unitId missing in STG job ${jobId}`;
      this.logger.warn(`MoveOut.cancelled: ${reason} — skipping`);
      return { softError: reason };
    }

    const unit = await this.sgApi.getUnit(unitId);
    const parsed = await resolveUnitMapping(this.sgApi, unit);
    if (!parsed) {
      const reason = `smartcube_id missing for unit ${unitId}`;
      this.logger.warn(`MoveOut.cancelled: ${reason} — skipping`);
      return { softError: reason, stgUnitId: unitId };
    }
    const { areaCode, showBoxNo } = parsed;
    const stgFetchMs = Date.now() - stgFetchStart;

    const dbStart = Date.now();
    let cancelledRow:
      | {
          useState: number;
          isOverlocked: number;
          userPhone: string;
          userCode: string;
          userName: string;
        }
      | undefined;
    const transaction = await this.db.beginTransaction();
    try {
      // 현재 상태 조회
      const unitResult = await new sql.Request(transaction)
        .input('areaCode', sql.NVarChar, areaCode)
        .input('showBoxNo', sql.Int, showBoxNo)
        .query<{
          useState: number;
          isOverlocked: number;
          userPhone: string;
          userCode: string;
          userName: string;
        }>(`SELECT useState, ISNULL(isOverlocked, 0) AS isOverlocked, userPhone, userCode, userName FROM tblBoxMaster WHERE areaCode = @areaCode AND showBoxNo = @showBoxNo`);

      cancelledRow = unitResult.recordset[0];
      if (!cancelledRow) {
        await safeRollback(transaction);
        return {
          areaCode, showBoxNo,
          softError: `Unit not found in DB: ${areaCode}:${showBoxNo}`,
        };
      }
      const wasBlocked =
        cancelledRow?.useState === 3 &&
        (cancelledRow?.isOverlocked ?? 0) === 0;

      // endTime 복원 + moveOut 차단 해제 (오버락 아닌 경우)
      await new sql.Request(transaction)
        .input('areaCode', sql.NVarChar, areaCode)
        .input('showBoxNo', sql.Int, showBoxNo)
        .query(
          `UPDATE tblBoxMaster SET endTime = '2099-12-31 23:59:59'${wasBlocked ? ', useState = 1' : ''}, updateTime = GETDATE() WHERE areaCode = @areaCode AND showBoxNo = @showBoxNo`,
        );

      // 차단 해제 시 group 내 다른 blocker 확인 후 PTI 복원
      if (wasBlocked && cancelledRow?.userPhone) {
        const blockerCheck = await new sql.Request(transaction)
          .input('areaCode', sql.NVarChar, areaCode)
          .input('stgUserId', sql.NVarChar, cancelledRow.userCode || null)
          .input('userPhone', sql.NVarChar, cancelledRow.userPhone)
          .input('showBoxNo', sql.Int, showBoxNo)
          .query<{ cnt: number }>(
            `SELECT COUNT(*) AS cnt FROM tblBoxMaster
             WHERE areaCode = @areaCode
               AND userCode = @stgUserId
               AND isOverlocked = 1
               AND showBoxNo <> @showBoxNo`,
          );
        const otherBlockerCount = blockerCheck.recordset[0]?.cnt ?? 0;

        if (otherBlockerCount === 0) {
          await setPtiUserEnableAllForGroup(
            transaction,
            areaCode,
            cancelledRow.userPhone,
            1,
            cancelledRow.userCode,
          );
          this.logger.log(
            `MoveOut.cancelled: unit + group gate restored — areaCode=${areaCode} showBoxNo=${showBoxNo}`,
          );
        } else {
          this.logger.log(
            `MoveOut.cancelled: unit restored but gate stays blocked (${otherBlockerCount} other blocker(s) remain) — areaCode=${areaCode} showBoxNo=${showBoxNo}`,
          );
        }
      }

      // 퇴거 취소로 endTime/상태 복원
      await insertBoxHistorySnapshot(
        transaction,
        areaCode,
        showBoxNo,
        StgEventType.MoveoutCancel,
      );

      // 동일 unit의 pending moveOut.block 스케줄 취소.
      // MoveInActivate는 의도적으로 제외 — moveOut 취소가 moveIn 예약까지
      // 돌이키면 안 되기 때문. 미래 moveIn이 예약돼 있었다면 그대로 유지된다.
      const cancelledCount = await this.scheduledJobRepo.cancelPendingForUnit(
        transaction,
        areaCode,
        showBoxNo,
        [ScheduledJobEventType.MoveOutBlock],
        `webhook:${payload.type}:${jobId}`,
      );
      if (cancelledCount > 0) {
        this.logger.log(
          `MoveOut.cancelled: cancelled ${cancelledCount} pending schedule(s) — areaCode=${areaCode} showBoxNo=${showBoxNo}`,
        );
      }

      await transaction.commit();
      const dbMs = Date.now() - dbStart;

      const totalMs = Date.now() - totalStart;
      this.logger.log(
        `MoveOut.cancelled: ✓ Complete — STG fetch: ${stgFetchMs}ms, DB: ${dbMs}ms, Total: ${totalMs}ms — areaCode=${areaCode} showBoxNo=${showBoxNo}`,
      );
    } catch (err) {
      await transaction.rollback();
      this.logger.error(
        `MoveOut.cancelled: transaction rolled back — ${(err as Error).message}`,
      );
      throw err;
    }

    return {
      areaCode,
      showBoxNo,
      userName: cancelledRow?.userName,
      stgUserId: cancelledRow?.userCode,
      stgUnitId: unitId,
    };
  }
}

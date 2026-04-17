import { Logger } from '@nestjs/common';
import * as sql from 'mssql';
import {
  insertBoxHistorySnapshot,
  deletePtiUserForUnit,
  setPtiUserEnableAllForGroup,
} from './db-utils';
import { StgEventType } from './event-types';

/**
 * Move Out 완료 시 DB 처리 공통 로직.
 * 웹훅 핸들러와 스케줄러 양쪽에서 동일하게 사용.
 *
 * 1. tblBoxMaster 초기화 (useState=2, 유저 정보 클리어, boxPassword='2580')
 * 2. tblBoxHistory 스냅샷 (기본 eventType=MoveoutComplete(142))
 *    - transfer 경로에서는 caller 가 TransferOut(144) 로 override
 * 3. 해당 유닛에 대응하는 tblPTIUserInfo 삭제
 */
export async function executeMoveOutCompletion(
  transaction: sql.Transaction,
  areaCode: string,
  showBoxNo: number,
  logger: Logger,
  stgUserId?: string,
  wasOverlocked = false,
  eventType: number = StgEventType.MoveoutComplete,
): Promise<void> {
  // 1. tblBoxMaster 초기화
  const req = new sql.Request(transaction);
  req.input('areaCode', sql.NVarChar, areaCode);
  req.input('showBoxNo', sql.Int, showBoxNo);
  await req.query(`
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
  logger.debug(
    `tblBoxMaster reset — areaCode: ${areaCode}, showBoxNo: ${showBoxNo}`,
  );

  // 2. tblBoxHistory 스냅샷 (caller 가 eventType override 가능)
  await insertBoxHistorySnapshot(transaction, areaCode, showBoxNo, eventType);
  logger.debug(`tblBoxHistory snapshot inserted (eventType=${eventType})`);

  await deletePtiUserForUnit(transaction, areaCode, showBoxNo, stgUserId);
  logger.log(
    `tblPTIUserInfo deleted for unit — areaCode=${areaCode}, showBoxNo=${showBoxNo}, stgUserId=${stgUserId ?? '(none)'}`,
  );

  // Q7: 오버락됐던 유닛이면 같은 group 내 다른 차단 유닛 확인 후 PTI 복구
  if (wasOverlocked) {
    const overdueCheck = await new sql.Request(transaction)
      .input('areaCode', sql.NVarChar, areaCode)
      .input('stgUserId', sql.NVarChar, stgUserId ?? null)
      .input('showBoxNo', sql.Int, showBoxNo)
      .query<{ cnt: number }>(
        `SELECT COUNT(*) AS cnt FROM tblBoxMaster
         WHERE areaCode = @areaCode
           AND userCode = @stgUserId
           AND isOverlocked = 1
           AND showBoxNo <> @showBoxNo`,
      );

    const otherOverlockedCount = overdueCheck.recordset[0]?.cnt ?? 0;
    if (otherOverlockedCount === 0) {
      // 다른 차단 없음 — 사용자 그룹 PTI 전체 복구 (게이트 오픈)
      // isOverlocked 는 유닛별 독립 상태이므로 다른 유닛 건드리지 않음
      // (해당 유닛의 isOverlocked=0 은 위 executeMoveOutCompletion reset 에서 이미 처리)
      await setPtiUserEnableAllForGroup(transaction, areaCode, 1, stgUserId);
      logger.log(
        `Q7 recovery: group PTI re-enabled for user (no other overlocked units remain)`,
      );
    } else {
      logger.log(
        `Q7 recovery skipped: ${otherOverlockedCount} other overlocked unit(s) still exist in group`,
      );
    }
  }
}

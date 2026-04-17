import * as sql from 'mssql';
import { generateAccessCode } from './utils';

/**
 * 트랜잭션 rollback을 안전하게 수행.
 * SQL Server가 에러 시 자동 rollback하면 수동 rollback이 "no corresponding BEGIN TRANSACTION"으로 실패한다.
 * 이 함수는 그 경우를 무시하여 원래 에러가 가려지는 것을 방지한다.
 */
export async function safeRollback(
  transaction: sql.Transaction,
): Promise<void> {
  try {
    await transaction.rollback();
  } catch {
    // 이미 rollback된 상태 — 무시
  }
}

/**
 * tblBoxMaster의 현재 상태를 tblBoxHistory에 스냅샷 INSERT.
 *
 * 중요: tblBoxHistory는 기존 스키마 유지 (boxNo 컬럼 저장)이지만 외부 호출자는
 *   showBoxNo로만 대화한다. 내부 SELECT가 tblBoxMaster에서 내부 boxNo를 자동 복사해
 *   히스토리에 그대로 쓴다. bridging이 함수 내부에 숨겨져 호출자는 boxNo를 모른다.
 */
export async function insertBoxHistorySnapshot(
  transaction: sql.Transaction,
  areaCode: string,
  showBoxNo: number,
  eventType: number,
): Promise<void> {
  const req = new sql.Request(transaction);
  req.input('eventType', sql.TinyInt, eventType);
  req.input('areaCode', sql.NVarChar, areaCode);
  req.input('showBoxNo', sql.Int, showBoxNo);

  await req.query(`
    INSERT INTO tblBoxHistory (
      eventType, areaCode, boxNo, serviceType, boxSizeType, useState,
      userCode, userName, userPhone, dong, addressNum, transCode, transPhone,
      barcode, deliveryType, boxPassword, payCode, payAmount, useTimeType,
      startTime, endTime, createDate, Sequence, gatewaySN, UserCardNo,
      updateTime, syncTime, lockStatus, adminCardNo, adminPasswd, NfcID
    )
    SELECT
      @eventType, areaCode, boxNo, serviceType, boxSizeType, useState,
      userCode, userName, userPhone, dong, addressNum, transCode, transPhone,
      barcode, deliveryType, boxPassword, payCode, payAmount, useTimeType,
      startTime, endTime, GETDATE(), Sequence, gatewaySN, UserCardNo,
      updateTime, syncTime, lockStatus, adminCardNo, adminPasswd, NfcID
    FROM tblBoxMaster
    WHERE areaCode = @areaCode AND showBoxNo = @showBoxNo
  `);
}

/**
 * OfficeCode(4자리) → areaCode prefix 변환.
 * '0003' → 'strh003%' (SQL LIKE용)
 */
export function officeCodeToAreaPrefix(officeCode: string): string {
  return 'strh' + officeCode.replace(/^0/, '');
}

/**
 * AreaCode에서 OfficeCode, GroupCode 파싱.
 * areaCode = "strh" + officeCode(3자리) + groupCode(4자리) = 11자리
 * "strh0010001" → { officeCode: "0001", groupCode: "0001" }
 * officeCode는 PTI 호환을 위해 4자리로 패딩
 */
export function parseAreaCodeParts(areaCode: string): {
  officeCode: string;
  groupCode: string;
} {
  return {
    officeCode: areaCode.slice(4, 7).padStart(4, '0'),
    groupCode: areaCode.slice(7, 11),
  };
}

export interface InsertPtiUserParams {
  areaCode: string;
  showBoxNo: number;
  userPhone: string;
  userName: string;
  accessCode: string;
  enable?: 0 | 1;
  stgUserId?: string;
}

/**
 * tblPTIUserInfo INSERT.
 * showBoxNo를 외부에서 직접 받아 그대로 저장 (PTI 테이블은 이미 showBoxNo 기반).
 */
export async function insertPtiUser(
  transaction: sql.Transaction,
  params: InsertPtiUserParams,
): Promise<void> {
  const {
    areaCode,
    showBoxNo,
    userPhone,
    userName,
    accessCode,
    enable = 1,
    stgUserId,
  } = params;
  const { officeCode, groupCode } = parseAreaCodeParts(areaCode);

  const req = new sql.Request(transaction);
  req.input('accessCode', sql.NVarChar, accessCode);
  req.input('siteCode', sql.NVarChar, 'STRH');
  req.input('officeCode', sql.NVarChar, officeCode);
  req.input('groupCode', sql.NVarChar, groupCode);
  req.input('areaCode', sql.NVarChar, areaCode);
  req.input('showBoxNo', sql.Int, showBoxNo);
  req.input('userPhone', sql.NVarChar, userPhone);
  req.input('userName', sql.NVarChar, userName);
  req.input('enable', sql.TinyInt, enable);
  req.input('stgUserId', sql.NVarChar, stgUserId ?? null);

  await req.query(`
    INSERT INTO tblPTIUserInfo (
      AccessCode, SiteCode, OfficeCode, GroupCode, AreaCode,
      showBoxNo, UserPhone, UserName, Enable, UserType,
      StgUserId, UpdateTime, CreateTime
    )
    VALUES (
      @accessCode, @siteCode, @officeCode, @groupCode, @areaCode,
      @showBoxNo, @userPhone, @userName, @enable, 'C',
      @stgUserId, GETDATE(), GETDATE()
    )
  `);
}

/**
 * 기존 고객 AccessCode 조회 (Q9-a).
 * stgUserId 로만 매칭. 신규 사용자(매칭 없음)는 null 반환 → 호출측에서 신규 생성.
 * 불일치 감지 시 최다 사용 코드로 정렬하여 반환 + 불일치 row 일괄 수정 (데이터 복구).
 */
export async function findExistingAccessCode(
  transaction: sql.Transaction,
  officeCode: string,
  stgUserId?: string,
): Promise<string | null> {
  if (!stgUserId) return null;

  const req = new sql.Request(transaction);
  req.input('officeCode', sql.NVarChar, officeCode);
  req.input('stgUserId', sql.NVarChar, stgUserId);

  // 최다 사용 코드 기준으로 조회 (불일치 대응)
  const result = await req.query<{ AccessCode: string; cnt: number }>(
    `SELECT AccessCode, COUNT(*) AS cnt FROM tblPTIUserInfo
     WHERE StgUserId = @stgUserId AND OfficeCode = @officeCode
     GROUP BY AccessCode
     ORDER BY cnt DESC, AccessCode`,
  );
  if (result.recordset.length === 0) return null;
  const winner = result.recordset[0].AccessCode;

  // 불일치 row 가 있으면 일괄 수정 (최다 코드로 정렬)
  if (result.recordset.length > 1) {
    const fixReq = new sql.Request(transaction);
    fixReq.input('officeCode', sql.NVarChar, officeCode);
    fixReq.input('stgUserId', sql.NVarChar, stgUserId);
    fixReq.input('accessCode', sql.NVarChar, winner);
    await fixReq.query(
      `UPDATE tblPTIUserInfo
       SET AccessCode = @accessCode, UpdateTime = GETDATE()
       WHERE StgUserId = @stgUserId AND OfficeCode = @officeCode AND AccessCode <> @accessCode`,
    );
  }

  return winner;
}

/**
 * 해당 지점에서 사용 중인 AccessCode 목록 조회 (중복 방지용).
 */
export async function getUsedAccessCodes(
  transaction: sql.Transaction,
  officeCode: string,
): Promise<Set<string>> {
  const req = new sql.Request(transaction);
  req.input('officeCode', sql.NVarChar, officeCode);

  const result = await req.query<{ AccessCode: string }>(
    `SELECT DISTINCT AccessCode FROM tblPTIUserInfo
     WHERE OfficeCode = @officeCode AND AccessCode IS NOT NULL`,
  );

  return new Set(result.recordset.map((r) => r.AccessCode));
}

/**
 * 해당 지점 내 중복되지 않는 6자리 AccessCode 생성.
 */
export async function generateUniqueAccessCode(
  transaction: sql.Transaction,
  officeCode: string,
): Promise<string> {
  const usedCodes = await getUsedAccessCodes(transaction, officeCode);

  const maxAttempts = 100;
  for (let i = 0; i < maxAttempts; i++) {
    const code = generateAccessCode(6);
    if (!usedCodes.has(code)) return code;
  }

  throw new Error(
    `Failed to generate unique access code for office ${officeCode} after ${maxAttempts} attempts`,
  );
}

/**
 * 특정 유닛(areaCode + showBoxNo)에 대응하는 PTI row를 upsert.
 * AccessCode 재사용 시에도 유닛별 PTI row가 하나씩 존재하도록 보장한다.
 */
export async function upsertPtiUserForUnit(
  transaction: sql.Transaction,
  params: InsertPtiUserParams,
): Promise<void> {
  const {
    areaCode,
    showBoxNo,
    userPhone,
    userName,
    accessCode,
    enable = 1,
    stgUserId,
  } = params;
  const { officeCode, groupCode } = parseAreaCodeParts(areaCode);

  // 기존 null-StgUserId 고스트 정리:
  //   같은 유닛에 StgUserId 가 비어 있는 레거시 row 는 마이그레이션 백필 미완성
  //   상태로 남은 row 다. tblBoxMaster 가 유닛당 현재 점유자 1명만 들고 있는
  //   모델이므로, 이 유닛을 StgUserId 보유한 사용자로 upsert 하려는 시점엔
  //   null row 는 전부 stale 하다. UPDATE 전에 삭제해 중복 증식을 막는다.
  //   multi-tenant 유닛도 004 가 성공한 경우 각자 StgUserId 를 가지므로 영향 없음.
  if (stgUserId) {
    const cleanupReq = new sql.Request(transaction);
    cleanupReq.input('officeCode', sql.NVarChar, officeCode);
    cleanupReq.input('areaCode', sql.NVarChar, areaCode);
    cleanupReq.input('showBoxNo', sql.Int, showBoxNo);
    await cleanupReq.query(`
      DELETE FROM tblPTIUserInfo
      WHERE OfficeCode = @officeCode
        AND AreaCode = @areaCode
        AND showBoxNo = @showBoxNo
        AND (StgUserId IS NULL OR StgUserId = '')
    `);
  }

  const req = new sql.Request(transaction);
  req.input('accessCode', sql.NVarChar, accessCode);
  req.input('officeCode', sql.NVarChar, officeCode);
  req.input('groupCode', sql.NVarChar, groupCode);
  req.input('areaCode', sql.NVarChar, areaCode);
  req.input('showBoxNo', sql.Int, showBoxNo);
  req.input('userPhone', sql.NVarChar, userPhone);
  req.input('userName', sql.NVarChar, userName);
  req.input('enable', sql.TinyInt, enable);
  req.input('stgUserId', sql.NVarChar, stgUserId ?? null);

  const updateResult = await req.query(`
    UPDATE pti
    SET
      pti.AccessCode = @accessCode,
      pti.GroupCode = @groupCode,
      pti.AreaCode = @areaCode,
      pti.showBoxNo = @showBoxNo,
      pti.UserPhone = @userPhone,
      pti.UserName = @userName,
      pti.Enable = @enable,
      pti.StgUserId = @stgUserId,
      pti.UpdateTime = GETDATE()
    FROM tblPTIUserInfo pti
    WHERE pti.OfficeCode = @officeCode
      AND pti.AreaCode = @areaCode
      AND pti.showBoxNo = @showBoxNo
      AND pti.StgUserId = @stgUserId
  `);

  if ((updateResult.rowsAffected?.[0] ?? 0) > 0) return;

  await insertPtiUser(transaction, params);
}

/**
 * 같은 그룹(AreaCode) 내 해당 사용자의 모든 PTI row Enable 변경.
 * 게이트 차단/해제처럼 group-wide 동작이 필요한 시나리오에서 사용.
 */
export async function setPtiUserEnableAllForGroup(
  transaction: sql.Transaction,
  areaCode: string,
  enable: 0 | 1,
  stgUserId?: string,
): Promise<void> {
  const req = new sql.Request(transaction);
  req.input('areaCode', sql.NVarChar, areaCode);
  req.input('enable', sql.TinyInt, enable);
  req.input('stgUserId', sql.NVarChar, stgUserId ?? null);

  await req.query(`
    UPDATE tblPTIUserInfo
    SET Enable = @enable,
        UpdateTime = GETDATE()
    WHERE AreaCode = @areaCode
      AND StgUserId = @stgUserId
  `);
}

/**
 * PTI row의 바라보는 유닛을 변경 (트랜스퍼용).
 * 기존 유닛(oldAreaCode + oldShowBoxNo)에 매핑된 PTI row를
 * 신규 유닛(newAreaCode + newShowBoxNo)으로 이전한다.
 */
export async function relocatePtiUserToUnit(
  transaction: sql.Transaction,
  params: {
    oldAreaCode: string;
    oldShowBoxNo: number;
    newAreaCode: string;
    newShowBoxNo: number;
    stgUserId?: string;
  },
): Promise<void> {
  const { groupCode: newGroupCode } = parseAreaCodeParts(params.newAreaCode);

  const req = new sql.Request(transaction);
  req.input('oldAreaCode', sql.NVarChar, params.oldAreaCode);
  req.input('oldShowBoxNo', sql.Int, params.oldShowBoxNo);
  req.input('newAreaCode', sql.NVarChar, params.newAreaCode);
  req.input('newShowBoxNo', sql.Int, params.newShowBoxNo);
  req.input('newGroupCode', sql.NVarChar, newGroupCode);
  req.input('stgUserId', sql.NVarChar, params.stgUserId ?? null);

  await req.query(`
    UPDATE tblPTIUserInfo
    SET
      GroupCode  = @newGroupCode,
      AreaCode   = @newAreaCode,
      showBoxNo  = @newShowBoxNo,
      UpdateTime = GETDATE()
    WHERE AreaCode = @oldAreaCode
      AND showBoxNo = @oldShowBoxNo
      AND StgUserId = @stgUserId
  `);
}

/**
 * 특정 유닛(areaCode + showBoxNo)에 대응하는 PTI row만 삭제.
 */
export async function deletePtiUserForUnit(
  transaction: sql.Transaction,
  areaCode: string,
  showBoxNo: number,
  stgUserId?: string,
): Promise<void> {
  const req = new sql.Request(transaction);
  req.input('areaCode', sql.NVarChar, areaCode);
  req.input('showBoxNo', sql.Int, showBoxNo);
  req.input('stgUserId', sql.NVarChar, stgUserId ?? null);

  await req.query(`
    DELETE FROM tblPTIUserInfo
    WHERE AreaCode = @areaCode
      AND showBoxNo = @showBoxNo
      AND StgUserId = @stgUserId
  `);
}

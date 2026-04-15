#!/usr/bin/env node
/**
 * 004: PTI per-unit reconciliation
 *
 * 목적:
 * - 사용자×유닛 단위 PTI row를 BoxMaster 배정 상태(useState IN (1,3))와 맞춘다.
 * - 같은 지점 내 AccessCode는 공유 가능하므로, 기존 최신 PTI AccessCode를 재사용한다.
 * - stale PTI row(더 이상 배정되지 않은 유닛)는 제거한다.
 *
 * 기본은 dry-run 이며, 실제 반영하려면 DRY_RUN=false 로 실행한다.
 *
 * 사용법:
 *   node migrations/004-reconcile-pti-per-unit.js                              # dry-run
 *   DRY_RUN=false node migrations/004-reconcile-pti-per-unit.js                # 실제 실행
 *   DRY_RUN=false node migrations/004-reconcile-pti-per-unit.js --offices 001  # 지점 제한
 */

const path = require('path');
const sql = require('mssql');
const { resolveSites, parseOfficesArg, toDbOfficeCode } = require('./lib/sites');

try {
  require('dotenv').config({
    path: process.env.ENV_PATH || path.join(__dirname, '..', '.env'),
  });
} catch {
  /* dotenv optional */
}

const DRY_RUN = (process.env.DRY_RUN ?? 'true') !== 'false';
// --offices 로 대상 지점을 좁힐 수 있다. 미지정 시 전체 DB 스캔(기존 동작).
// SCOPED 판단은 CLI 인자 존재 여부로만 — 지점 개수가 늘어나도 의미가 안 꼬이게.
// 실제 TARGET_SITES 는 STG API 호출이 필요하므로 main() 안에서 초기화.
const CLI_OFFICES_RAW = parseOfficesArg();
const SCOPED = CLI_OFFICES_RAW != null;

const dbConfig = {
  server: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT ?? '1433', 10),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  options: {
    encrypt: false,
    trustServerCertificate: true,
  },
};

function parseAreaCodeParts(areaCode) {
  return {
    officeCode: areaCode.slice(4, 7).padStart(4, '0'),
    groupCode: areaCode.slice(7, 11),
  };
}

function userKey(row) {
  return row.StgUserId || `phone:${row.UserPhone}`;
}

async function main() {
  console.log('=== 004: PTI per-unit reconciliation ===');
  console.log(`DRY_RUN=${DRY_RUN}`);

  // STG 에서 site 목록 조회 (customFields.smartcube_siteCode 기반). 4자리 officeCode.
  const TARGET_SITES = await resolveSites(CLI_OFFICES_RAW);
  const TARGET_OFFICES = TARGET_SITES.map((s) => s.officeCode);
  console.log(`대상 지점: ${SCOPED ? TARGET_OFFICES.join(', ') : '전체'}`);

  const pool = await sql.connect(dbConfig);

  // --offices 지정 시 WHERE 절에 officeCode/areaCode 필터 주입.
  // DB 레거시 포맷: areaCode `strh<3자리officeCode><4자리groupCode>`, OfficeCode 컬럼도 3자리.
  // 4자리 site.officeCode 는 toDbOfficeCode() 로 마지막 3자리만 뽑아 쿼리에 전달.
  const areaCodeFilter = SCOPED
    ? ` AND (${TARGET_OFFICES.map((c, i) => `areaCode LIKE @areaPrefix${i}`).join(' OR ')})`
    : '';
  const officeCodeFilter = SCOPED
    ? ` AND OfficeCode IN (${TARGET_OFFICES.map((_, i) => `@officeCode${i}`).join(', ')})`
    : '';

  const bindOffices = (req) => {
    if (!SCOPED) return req;
    TARGET_OFFICES.forEach((code, i) => {
      const code3 = toDbOfficeCode(code);
      req.input(`areaPrefix${i}`, sql.NVarChar, `strh${code3}%`);
      req.input(`officeCode${i}`, sql.NVarChar, code3);
    });
    return req;
  };

  try {
    const boxes = (
      await bindOffices(pool.request()).query(`
        SELECT areaCode, boxNo, showBoxNo, useState, userCode, userName, userPhone
        FROM tblBoxMaster
        WHERE useState IN (1, 3)
          AND userPhone IS NOT NULL
          AND userPhone <> ''${areaCodeFilter}
      `)
    ).recordset;

    const ptis = (
      await bindOffices(pool.request()).query(`
        SELECT AccessCode, SiteCode, OfficeCode, GroupCode, AreaCode, showBoxNo,
               UserPhone, UserName, Enable, UserType, StgUserId, UpdateTime, CreateTime
        FROM tblPTIUserInfo
        WHERE UserType = 'C'${officeCodeFilter}
      `)
    ).recordset;

    const boxGroups = new Map();
    for (const box of boxes) {
      const { officeCode, groupCode } = parseAreaCodeParts(box.areaCode);
      const key = `${officeCode}|${box.userCode || `phone:${box.userPhone}`}`;
      if (!boxGroups.has(key)) {
        boxGroups.set(key, {
          officeCode,
          stgUserId: box.userCode || null,
          userPhone: box.userPhone,
          userName: box.userName,
          units: [],
        });
      }
      boxGroups.get(key).units.push({
        areaCode: box.areaCode,
        groupCode,
        showBoxNo: box.showBoxNo,
        boxNo: box.boxNo,
        enable: box.useState === 1 ? 1 : 0,
      });
    }

    const ptiGroups = new Map();
    for (const pti of ptis) {
      const key = `${pti.OfficeCode}|${userKey(pti)}`;
      if (!ptiGroups.has(key)) ptiGroups.set(key, []);
      ptiGroups.get(key).push(pti);
    }

    let toInsert = 0;
    let toUpdate = 0;
    let toDelete = 0;

    const tx = new sql.Transaction(pool);
    if (!DRY_RUN) await tx.begin();

    try {
      for (const [key, group] of boxGroups.entries()) {
        const existing = ptiGroups.get(key) ?? [];
        existing.sort((a, b) => new Date(b.UpdateTime).getTime() - new Date(a.UpdateTime).getTime());
        const accessCode = existing[0]?.AccessCode ?? null;

        if (!accessCode) {
          // 005 시점에 AccessCode 가 없는 사용자는 006 에서 findExistingAccessCode
          // 실패 후 generateUniqueAccessCode 로 새 코드를 발급받거나, STG 에 rental
          // 이 없는 경우 이후 삭제된다. 005 는 "기존 코드 재사용" 역할이므로 여기서
          // 할 일이 없어 skip.
          continue;
        }

        const expectedKeys = new Set(group.units.map((u) => `${u.areaCode}|${u.showBoxNo}`));
        const existingKeys = new Set(existing.map((r) => `${r.AreaCode}|${r.showBoxNo}`));

        for (const unit of group.units) {
          const composite = `${unit.areaCode}|${unit.showBoxNo}`;
          if (!existingKeys.has(composite)) {
            toInsert += 1;
            console.log(`[INSERT] ${key} -> ${unit.areaCode}#${unit.showBoxNo} accessCode=${accessCode}`);
            if (!DRY_RUN) {
              await new sql.Request(tx)
                .input('accessCode', sql.NVarChar, accessCode)
                .input('officeCode', sql.NVarChar, group.officeCode)
                .input('groupCode', sql.NVarChar, unit.groupCode)
                .input('areaCode', sql.NVarChar, unit.areaCode)
                .input('boxNo', sql.Int, unit.boxNo)
                .input('userPhone', sql.NVarChar, group.userPhone)
                .input('userName', sql.NVarChar, group.userName)
                .input('enable', sql.TinyInt, unit.enable)
                .input('stgUserId', sql.NVarChar, group.stgUserId)
                .query(`
                  INSERT INTO tblPTIUserInfo (
                    AccessCode, SiteCode, OfficeCode, GroupCode, AreaCode,
                    showBoxNo, UserPhone, UserName, Enable, UserType,
                    StgUserId, UpdateTime, CreateTime
                  )
                  SELECT
                    @accessCode, 'STRH', @officeCode, @groupCode, @areaCode,
                    ISNULL(bm.showBoxNo, 0), @userPhone, @userName, @enable, 'C',
                    @stgUserId, GETDATE(), GETDATE()
                  FROM tblBoxMaster bm
                  WHERE bm.areaCode = @areaCode AND bm.boxNo = @boxNo
                `);
            }
          } else {
            toUpdate += 1;
            console.log(`[UPDATE] ${key} -> ${unit.areaCode}#${unit.showBoxNo} enable=${unit.enable}`);
            if (!DRY_RUN) {
              await new sql.Request(tx)
                .input('officeCode', sql.NVarChar, group.officeCode)
                .input('areaCode', sql.NVarChar, unit.areaCode)
                .input('showBoxNo', sql.Int, unit.showBoxNo)
                .input('userPhone', sql.NVarChar, group.userPhone)
                .input('userName', sql.NVarChar, group.userName)
                .input('enable', sql.TinyInt, unit.enable)
                .input('stgUserId', sql.NVarChar, group.stgUserId)
                .query(`
                  UPDATE tblPTIUserInfo
                  SET UserPhone = @userPhone,
                      UserName = @userName,
                      Enable = @enable,
                      StgUserId = @stgUserId,
                      UpdateTime = GETDATE()
                  WHERE OfficeCode = @officeCode
                    AND AreaCode = @areaCode
                    AND showBoxNo = @showBoxNo
                `);
            }
          }
        }

        for (const row of existing) {
          const composite = `${row.AreaCode}|${row.showBoxNo}`;
          if (!expectedKeys.has(composite)) {
            toDelete += 1;
            console.log(`[DELETE] ${key} stale -> ${row.AreaCode}#${row.showBoxNo} accessCode=${row.AccessCode}`);
            if (!DRY_RUN) {
              await new sql.Request(tx)
                .input('officeCode', sql.NVarChar, row.OfficeCode)
                .input('areaCode', sql.NVarChar, row.AreaCode)
                .input('showBoxNo', sql.Int, row.showBoxNo)
                .input('userPhone', sql.NVarChar, row.UserPhone)
                .input('stgUserId', sql.NVarChar, row.StgUserId)
                .query(`
                  DELETE FROM tblPTIUserInfo
                  WHERE OfficeCode = @officeCode
                    AND AreaCode = @areaCode
                    AND showBoxNo = @showBoxNo
                    AND (StgUserId = @stgUserId OR (StgUserId IS NULL AND UserPhone = @userPhone))
                `);
            }
          }
        }
      }

      if (!DRY_RUN) await tx.commit();
      console.log('---');
      console.log(JSON.stringify({ dryRun: DRY_RUN, toInsert, toUpdate, toDelete }, null, 2));
    } catch (err) {
      if (!DRY_RUN) await tx.rollback();
      throw err;
    }
  } finally {
    await pool.close();
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});

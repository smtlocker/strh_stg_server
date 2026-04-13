#!/usr/bin/env node
/**
 * 002: STG 유닛 smartcube_id 일괄 upsert (showBoxNo 기반)
 *
 * 새 형식: "{groupCode}:{showBoxNo}" (예: "0001:1214")
 *   - showBoxNo는 STG unit.name과 일치하는 운영자 표시 번호
 *   - parseSmartcubeId → { groupCode, showBoxNo } 로 파싱됨
 *
 * 동작:
 *   - 기존 값 있음(구 형식 "strh0010001:214" 또는 구 showBoxNo 없는 형식 "0001:214")
 *     → DB join으로 실제 showBoxNo 조회 후 신 형식 "0001:1214"으로 UPDATE
 *   - 기존 값 없음 → DB showBoxNo 매핑으로 신규 세팅
 *   - 이미 신 형식(`groupCode:showBoxNo` 매칭)이면 skip
 *
 * 사용법:
 *   node migrations/002-upsert-unit-smartcube-ids.js              # dry-run
 *   DRY_RUN=false node migrations/002-upsert-unit-smartcube-ids.js # 실제 실행
 *   ENV_PATH=/path/to/prod.env DRY_RUN=false node ...             # 프로덕션
 */

const path = require('path');
const sql = require('mssql');

// .env 로드
const envPath = process.env.ENV_PATH || path.join(__dirname, '..', '.env');
try { require('dotenv').config({ path: envPath }); } catch { /* dotenv optional */ }

const DRY_RUN = (process.env.DRY_RUN ?? 'true') !== 'false';
const DELAY_MS = parseInt(process.env.DELAY_MS ?? '100', 10);

const SG_BASE = process.env.SG_BASE_URL;
const SG_KEY = process.env.SG_API_KEY;

const { SITES } = require('./lib/sites');

const dbConfig = {
  server: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT ?? '1433', 10),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  options: { encrypt: false, trustServerCertificate: true },
};

async function sgGet(endpoint) {
  const res = await fetch(`${SG_BASE}${endpoint}`, {
    headers: { Authorization: `ApiKey ${SG_KEY}` },
  });
  if (!res.ok) throw new Error(`STG API ${res.status}: ${endpoint}`);
  return res.json();
}

async function sgPut(endpoint, body) {
  const res = await fetch(`${SG_BASE}${endpoint}`, {
    method: 'PUT',
    headers: {
      Authorization: `ApiKey ${SG_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`STG PUT ${res.status}: ${endpoint}`);
  return res.json();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log(`=== 002: 유닛 smartcube_id upsert ===`);
  console.log(`DRY_RUN=${DRY_RUN}  DELAY=${DELAY_MS}ms`);
  console.log(`DB: ${dbConfig.server}:${dbConfig.port}/${dbConfig.database}`);
  console.log(`STG: ${SG_BASE}\n`);

  // DB 연결
  const pool = await sql.connect(dbConfig);

  // DB 매핑 테이블 빌드
  // tblShowBoxNoDispInfo의 showBoxNoDisp가 STG unit.name과 1:1 매칭.
  // showBoxNoDisp(case-insensitive) → { areaCode, showBoxNo, groupCode }
  const dbRows = await pool.request().query(
    `SELECT areaCode, showBoxNo, showBoxNoDisp, groupCode FROM tblShowBoxNoDispInfo WHERE showBoxNoDisp IS NOT NULL`,
  );

  // officeCode → { showBoxNoDisp(lowercase) → { areaCode, showBoxNo, groupCode } }
  const dbMap = {};
  for (const row of dbRows.recordset) {
    const ac = row.areaCode;
    if (!ac || ac.length < 8) continue;
    const oc = ac.slice(4, 7); // officeCode (3자리)
    if (!dbMap[oc]) dbMap[oc] = {};
    const key = String(row.showBoxNoDisp).toLowerCase();
    dbMap[oc][key] = { areaCode: ac, showBoxNo: row.showBoxNo, groupCode: row.groupCode };
  }

  let grandTotal = { total: 0, updated: 0, created: 0, skipped: 0, noMatch: 0, failed: 0 };

  for (const site of SITES) {
    console.log(`=== [${site.name}] officeCode=${site.officeCode} ===`);
    const siteMap = dbMap[site.officeCode] || {};

    // STG 유닛 전체 조회
    const units = await sgGet(`/v1/admin/units?siteId=${site.siteId}&limit=1000&include=customFields`);

    let stats = { total: 0, updated: 0, created: 0, skipped: 0, noMatch: 0, failed: 0 };

    for (const unit of units) {
      stats.total++;
      const unitId = unit.id;
      const unitName = unit.name || '';
      const currentId = unit.customFields?.smartcube_id || '';

      // DB에서 unit.name → showBoxNoDisp (case-insensitive) 매칭
      const match = siteMap[unitName.toLowerCase()] || null;

      if (!match) {
        // DB에 이 unit이 없음. 운영자 수동 개입 필요 (showBoxNo 정합성 체크 결과와 동일).
        stats.noMatch++;
        continue;
      }

      // 신 형식: "{groupCode}:{showBoxNo}"
      const newId = `${match.groupCode}:${match.showBoxNo}`;
      const action = currentId ? 'UPDATE' : 'CREATE';

      // 이미 동일한 값이면 skip
      if (currentId === newId) {
        stats.skipped++;
        continue;
      }

      if (DRY_RUN) {
        console.log(`  [dry-run] ${action} ${unitName}: ${currentId || '(empty)'} → ${newId}`);
        if (action === 'UPDATE') stats.updated++;
        else stats.created++;
      } else {
        try {
          await sgPut(`/v1/admin/units/${unitId}`, {
            customFields: { smartcube_id: newId },
          });
          console.log(`  OK ${action} ${unitName}: ${currentId || '(empty)'} → ${newId}`);
          if (action === 'UPDATE') stats.updated++;
          else stats.created++;
          await sleep(DELAY_MS);
        } catch (err) {
          console.log(`  FAIL ${unitName}: ${err.message}`);
          stats.failed++;
        }
      }
    }

    console.log(`  소계: total=${stats.total} updated=${stats.updated} created=${stats.created} skipped=${stats.skipped} noMatch=${stats.noMatch} failed=${stats.failed}\n`);
    for (const k of Object.keys(grandTotal)) grandTotal[k] += stats[k];
  }

  console.log('=========================================');
  console.log(`전체: total=${grandTotal.total} updated=${grandTotal.updated} created=${grandTotal.created} skipped=${grandTotal.skipped} noMatch=${grandTotal.noMatch} failed=${grandTotal.failed}`);
  if (DRY_RUN) console.log('\nDRY-RUN 완료. 실제 실행: DRY_RUN=false node migrations/002-upsert-unit-smartcube-ids.js');

  await pool.close();
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});

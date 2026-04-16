#!/usr/bin/env node
/**
 * 005: 전체 사이트 동기화
 *
 * STG 유닛을 순회하며 DB 상태를 STG에 맞춰 동기화.
 * NestJS 앱을 bootstrap하여 기존 UnitSyncHandler.syncUnit()을 호출.
 *
 * - STG occupied + DB에 유닛 존재 → syncUnit (정상 동기화)
 * - STG available/reserved + DB에 입주 데이터 있음 → skip + CSV 기록
 * - smartcube_id 없는 유닛 → skip
 *
 * 사용법:
 *   node migrations/005-site-sync.js                              # dry-run
 *   DRY_RUN=false node migrations/005-site-sync.js                # 실제 실행
 *   DRY_RUN=false node migrations/005-site-sync.js --offices 001  # 지점 제한
 *
 * 환경변수:
 *   CONCURRENCY   병렬 처리 동시성 (기본 5)
 */

const path = require('path');

// .env 로드
const envPath = process.env.ENV_PATH || path.join(__dirname, '..', '.env');
try { require('dotenv').config({ path: envPath }); } catch { /* optional */ }

// 마이그레이션 중 cron scheduler 비활성화
process.env.DISABLE_SCHEDULER = 'true';

const DRY_RUN = (process.env.DRY_RUN ?? 'true') !== 'false';

async function main() {
  console.log('=== 005: 전체 사이트 동기화 ===');
  console.log(`DRY_RUN=${DRY_RUN}`);

  const startTime = Date.now();

  // NestJS bootstrap
  const { NestFactory } = require('@nestjs/core');
  const { AppModule } = require(path.join(__dirname, '..', 'dist', 'src', 'app.module'));

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error'],
  });

  const { StoreganiseApiService } = require(path.join(__dirname, '..', 'dist', 'src', 'storeganise', 'storeganise-api.service'));
  const { UnitSyncHandler } = require(path.join(__dirname, '..', 'dist', 'src', 'handlers', 'unit-sync.handler'));
  const { DatabaseService } = require(path.join(__dirname, '..', 'dist', 'src', 'database', 'database.service'));

  const sgApi = app.get(StoreganiseApiService);
  const unitSync = app.get(UnitSyncHandler);
  const db = app.get(DatabaseService);

  const { resolveSites, parseOfficesArg, toDbOfficeCode } = require(path.join(__dirname, 'lib', 'sites'));
  const {
    parseUnitsArg,
    parseUnitsEntries,
    buildUnitFilter,
    officesFromEntries,
  } = require(path.join(__dirname, 'lib', 'units'));

  // --units 지정 시 해당 유닛만 sync. --offices 는 --units 의 officeCode 로 역산.
  const unitEntries = parseUnitsEntries(parseUnitsArg());
  const unitFilter = buildUnitFilter(unitEntries);
  const officesArg = unitFilter.enabled
    ? officesFromEntries(unitEntries)
    : parseOfficesArg();

  const SITES = await resolveSites(officesArg);
  console.log(
    `대상 지점: ${SITES.map((s) => `${s.officeCode}(${s.name})`).join(', ')}`,
  );
  if (unitFilter.enabled) {
    console.log(`대상 유닛: ${unitEntries.length}건 (--units 지정)`);
  }

  const skippedRows = [];
  const failedRows = [];
  const stats = { total: 0, synced: 0, skipped: 0, noSmartcubeId: 0, failed: 0, filtered: 0 };

  for (const site of SITES) {
    console.log(`\n=== [${site.name}] officeCode=${site.officeCode} ===`);

    const units = await sgApi.getUnitsForSite(site.siteId);
    console.log(`  STG 유닛: ${units.length}개`);

    // 순차 처리: 병렬화는 setPtiUserEnableAllForGroup 등에서 교차 그룹 lock 을
    // 유발해 deadlock 이 발생. 순차 처리하면 근본적으로 deadlock 없음.
    let done = 0;
    for (const unit of units) {
      await processUnit(unit, site);
      done++;
      if (done % 100 === 0 || done === units.length) {
        console.log(`  진행: ${done}/${units.length}`);
      }
    }
  }

  async function processUnit(unit, site) {
    stats.total++;
    const unitName = unit.name || unit.id;
    const smartcubeId = unit.customFields?.smartcube_id;
    if (!smartcubeId) {
      stats.noSmartcubeId++;
      console.log(`  [SKIP:NO_SMARTCUBE_ID] ${site.name}|${unitName}|${unit.id}|${(unit.state || '')}`);
      return;
    }

    // --units 지정 시 allow 목록에 없는 유닛은 스킵
    if (unitFilter.enabled) {
      const parsedId = parseSmartcubeId(smartcubeId);
      if (!parsedId || !unitFilter.has(site.officeCode, parsedId.groupCode, parsedId.showBoxNo)) {
        stats.filtered++;
        return;
      }
    }

    const stgState = (unit.state || '').toLowerCase();
    const rentalId = unit.rentalId;
    const isOccupied = stgState === 'occupied' && !!rentalId;

    // STG에 rental이 없는데 DB에 입주 데이터가 있는지 확인
    if (!isOccupied) {
      const parsed = parseSmartcubeId(smartcubeId);
      if (parsed) {
        // DB areaCode 는 `strh<3자리officeCode><4자리groupCode>` 레거시 포맷.
        const areaCode = 'strh' + toDbOfficeCode(site.officeCode) + parsed.groupCode;
        const boxResult = await db.query(
          'SELECT ISNULL(useState, 0) AS useState, ISNULL(userCode, \'\') AS userCode, ISNULL(userName, \'\') AS userName FROM tblBoxMaster WHERE areaCode = @areaCode AND showBoxNo = @showBoxNo',
          { areaCode, showBoxNo: parsed.showBoxNo },
        );
        const row = boxResult.recordset[0];
        if (row && row.useState === 1 && row.userCode) {
          skippedRows.push({
            site: site.name, areaCode, showBoxNo: parsed.showBoxNo,
            unitName, stgState, dbUserCode: row.userCode, dbUserName: row.userName,
          });
          stats.skipped++;
          console.log(`  [SKIP] ${unitName} (${areaCode}:${parsed.showBoxNo}) — DB 입주중 but STG ${stgState}`);
          return;
        }
      }
    }

    if (DRY_RUN) {
      stats.synced++;
      return;
    }

    // STG API 에러 (429, 5xx, network) 는 일시적이므로 재시도.
    // Deadlock 은 순차 처리로 구조적으로 제거됐으므로 재시도 대상 아님.
    const MAX_RETRIES = 5;
    let lastErr;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await unitSync.syncUnit(unit);
        stats.synced++;
        return;
      } catch (err) {
        lastErr = err;
        const msg = err.message || '';
        const isRetryable =
          /429/.test(msg) ||
          /5\d\d/.test(msg) ||
          /Storeganise API error/i.test(msg) ||
          /ECONNRESET|ETIMEDOUT|socket hang up/i.test(msg);
        if (!isRetryable || attempt === MAX_RETRIES) break;
        const delay = /429/.test(msg) ? 2000 * attempt : 300 * attempt;
        await new Promise(r => setTimeout(r, delay));
      }
    }
    const msg = lastErr.message || String(lastErr);
    console.log(`  [FAIL] ${unitName}: ${msg.substring(0, 100)}`);
    failedRows.push({ site: site.name, unitName, smartcubeId, error: msg });
    stats.failed++;
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n=== 결과 (${duration}s) ===`);
  console.log(JSON.stringify(stats, null, 2));

  if (skippedRows.length > 0) {
    console.log(`\n[SKIPPED] DB에만 입주 데이터 있는 유닛: ${skippedRows.length}건`);
    skippedRows.forEach(r => {
      console.log(`  [SKIP:DB_ONLY_OCCUPIED] ${r.site}|${r.areaCode}|${r.showBoxNo}|${r.unitName}|${r.stgState}|${r.dbUserCode}|${r.dbUserName}`);
    });
  }

  if (failedRows.length > 0) {
    console.log(`\n[FAILED] 동기화 실패: ${failedRows.length}건`);
    failedRows.forEach(r => {
      console.log(`  [FAIL:SYNC] ${r.site}|${r.unitName}|${r.smartcubeId}|${r.error.substring(0, 80)}`);
    });
  }

  await app.close();
  process.exit(0);
}

function parseSmartcubeId(id) {
  if (!id) return null;
  const sep = id.lastIndexOf(':');
  if (sep === -1) return null;
  const groupCode = id.slice(0, sep);
  const showBoxNo = parseInt(id.slice(sep + 1), 10);
  if (!groupCode || isNaN(showBoxNo)) return null;
  return { groupCode, showBoxNo };
}

main().catch(err => {
  console.error('실패:', err.message);
  process.exit(1);
});

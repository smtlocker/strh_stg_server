#!/usr/bin/env node
/**
 * 006: 전체 사이트 동기화
 *
 * STG 유닛을 순회하며 DB 상태를 STG에 맞춰 동기화.
 * NestJS 앱을 bootstrap하여 기존 UnitSyncHandler.syncUnit()을 호출.
 *
 * - STG occupied + DB에 유닛 존재 → syncUnit (정상 동기화)
 * - STG available/reserved + DB에 입주 데이터 있음 → skip + CSV 기록
 * - smartcube_id 없는 유닛 → skip
 *
 * 사용법:
 *   node migrations/006-site-sync.js          # dry-run
 *   DRY_RUN=false node migrations/006-site-sync.js  # 실제 실행
 */

const path = require('path');
const fs = require('fs');

// .env 로드
const envPath = process.env.ENV_PATH || path.join(__dirname, '..', '.env');
try { require('dotenv').config({ path: envPath }); } catch { /* optional */ }

const DRY_RUN = (process.env.DRY_RUN ?? 'true') !== 'false';
const DELAY_MS = parseInt(process.env.DELAY_MS ?? '200', 10);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log('=== 006: 전체 사이트 동기화 ===');
  console.log(`DRY_RUN=${DRY_RUN}  DELAY=${DELAY_MS}ms`);

  // NestJS bootstrap
  const { NestFactory } = require('@nestjs/core');
  const { AppModule } = require(path.join(__dirname, '..', 'dist', 'src', 'app.module'));

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  const { StoreganiseApiService } = require(path.join(__dirname, '..', 'dist', 'src', 'storeganise', 'storeganise-api.service'));
  const { UnitSyncHandler } = require(path.join(__dirname, '..', 'dist', 'src', 'handlers', 'unit-sync.handler'));
  const { DatabaseService } = require(path.join(__dirname, '..', 'dist', 'src', 'database', 'database.service'));

  const sgApi = app.get(StoreganiseApiService);
  const unitSync = app.get(UnitSyncHandler);
  const db = app.get(DatabaseService);

  const SITES = [
    { name: '송파점', officeCode: '001', siteId: '698ed8d861c38505daecc6b4' },
    { name: '마곡점', officeCode: '002', siteId: '69c217cd53c43d6dfe7266b0' },
    { name: '선릉점', officeCode: '003', siteId: '698eda4461c38505daee95eb' },
  ];

  const skippedRows = []; // DB에만 입주 데이터 있고 STG에 rental 없는 유닛
  const failedRows = [];
  const stats = { total: 0, synced: 0, skipped: 0, noSmartcubeId: 0, failed: 0 };

  for (const site of SITES) {
    console.log(`\n=== [${site.name}] officeCode=${site.officeCode} ===`);

    const units = await sgApi.getUnitsForSite(site.siteId);
    console.log(`  STG 유닛: ${units.length}개`);

    for (const unit of units) {
      stats.total++;
      const unitName = unit.name || unit.id;
      const smartcubeId = unit.customFields?.smartcube_id;
      if (!smartcubeId) {
        stats.noSmartcubeId++;
        console.log(`  [SKIP:NO_SMARTCUBE_ID] ${site.name}|${unitName}|${unit.id}|${(unit.state || '')}`);
        continue;
      }
      const stgState = (unit.state || '').toLowerCase();
      const rentalId = unit.rentalId;
      const isOccupied = stgState === 'occupied' && !!rentalId;

      // STG에 rental이 없는데 DB에 입주 데이터가 있는지 확인
      if (!isOccupied) {
        // DB 상태 확인
        const parsed = parseSmartcubeId(smartcubeId);
        if (parsed) {
          const areaPrefix = site.officeCode.replace(/^0/, '');
          const areaCode = 'strh' + areaPrefix + parsed.groupCode;
          const boxResult = await db.query(
            'SELECT ISNULL(useState, 0) AS useState, ISNULL(userCode, \'\') AS userCode, ISNULL(userName, \'\') AS userName FROM tblBoxMaster WHERE areaCode = @areaCode AND showBoxNo = @showBoxNo',
            { areaCode, showBoxNo: parsed.showBoxNo },
          );
          const row = boxResult.recordset[0];
          if (row && row.useState === 1 && row.userCode) {
            // DB에 입주 데이터가 있지만 STG에는 rental 없음 → skip
            skippedRows.push({
              site: site.name,
              areaCode,
              showBoxNo: parsed.showBoxNo,
              unitName,
              stgState,
              dbUserCode: row.userCode,
              dbUserName: row.userName,
            });
            stats.skipped++;
            console.log(`  [SKIP] ${unitName} (${areaCode}:${parsed.showBoxNo}) — DB 입주중 but STG ${stgState}, userCode=${row.userCode}`);
            continue;
          }
        }
      }

      // syncUnit 호출
      if (DRY_RUN) {
        console.log(`  [dry-run] ${unitName} → ${isOccupied ? 'syncWithRental' : 'syncEmpty'}`);
        stats.synced++;
      } else {
        try {
          await unitSync.syncUnit(unit);
          stats.synced++;
          await sleep(DELAY_MS);
        } catch (err) {
          const msg = err.message || String(err);
          console.log(`  [FAIL] ${unitName}: ${msg.substring(0, 100)}`);
          failedRows.push({ site: site.name, unitName, smartcubeId, error: msg });
          stats.failed++;
        }
      }
    }
  }

  console.log('\n=== 결과 ===');
  console.log(JSON.stringify(stats, null, 2));

  // CSV + 보고서는 migrate-all.js에서 처리하므로 stdout으로 JSON 출력
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
  // NestJS cron 스케줄러가 프로세스 종료를 방해하므로 강제 종료
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

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('실패:', err.message);
    process.exit(1);
  });

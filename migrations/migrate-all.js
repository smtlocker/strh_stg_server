#!/usr/bin/env node
/**
 * 전체 마이그레이션 순차 실행.
 *
 * 사용법:
 *   node migrations/migrate-all.js
 *
 * 결과물 (logs/ 폴더):
 *   - migrate-YYYYMMDD-HHmmss.log        상세 실행 로그
 *   - migrate-YYYYMMDD-HHmmss-report.md  마이그레이션 보고서
 *   - 004-ambiguous-YYYYMMDD-HHmmss.csv  수동 확인 필요: 사용자 매핑 모호
 *   - 004-name-mismatch-YYYYMMDD-HHmmss.csv  수동 확인 필요: 이름 불일치
 *   - 005-no-access-code-YYYYMMDD-HHmmss.csv  참고: AccessCode 미설정 PTI
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LOGS_DIR = path.join(ROOT, 'logs');

// .env 로드
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  fs.readFileSync(envFile, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim();
  });
}

if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

const now = new Date();
const ts = [
  now.getFullYear(),
  String(now.getMonth() + 1).padStart(2, '0'),
  String(now.getDate()).padStart(2, '0'),
  '-',
  String(now.getHours()).padStart(2, '0'),
  String(now.getMinutes()).padStart(2, '0'),
  String(now.getSeconds()).padStart(2, '0'),
].join('');
const logFile = path.join(LOGS_DIR, `migrate-${ts}.log`);
const reportFile = path.join(LOGS_DIR, `migrate-${ts}-report.md`);

const logLines = [];
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(logFile, line + '\n');
  logLines.push(msg);
}

const steps = [
  { name: '001 스키마 생성', cmd: `node migrations/run-sql.js migrations/001-init-schema.sql` },
  { name: '002 스케줄 백필', cmd: `node migrations/run-sql.js migrations/002-backfill-scheduled-jobs.sql` },
  { name: '003 STG 유닛 ID 매핑', cmd: `DRY_RUN=false node migrations/003-upsert-unit-smartcube-ids.js` },
  { name: '004 STG 사용자 ID 매핑', cmd: `DRY_RUN=false node migrations/004-migrate-stg-user-ids.js` },
  { name: '005 PTI 정합성 보정', cmd: `DRY_RUN=false node migrations/005-reconcile-pti-per-unit.js` },
  { name: '006 전체 사이트 동기화', cmd: `DRY_RUN=false node migrations/006-site-sync.js` },
];

const stepResults = [];

log(`마이그레이션 시작 (${steps.length}단계)`);
log(`로그 파일: ${logFile}`);
log('');

let failed = false;
for (let i = 0; i < steps.length; i++) {
  const step = steps[i];
  log(`[${i + 1}/${steps.length}] ${step.name} 실행 중...`);

  try {
    const output = execSync(step.cmd, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    const lines = output.trim() ? output.trim().split('\n') : [];
    lines.forEach((line) => log(`  ${line}`));
    log(`[${i + 1}/${steps.length}] ${step.name} — 완료`);
    log('');
    stepResults.push({ name: step.name, status: '완료', lines });
  } catch (err) {
    const stderr = err.stderr?.trim() || err.message;
    log(`[${i + 1}/${steps.length}] ${step.name} — 실패`);
    stderr.split('\n').forEach((line) => log(`  ERROR: ${line}`));
    log('');
    log('마이그레이션 중단. 이전 단계까지는 적용됨.');
    stepResults.push({ name: step.name, status: '실패' });
    failed = true;
    break;
  }
}

if (!failed) {
  log('전체 마이그레이션 완료.');
}

// ── CSV 추출 + 보고서 생성 ──

const allOutput = logLines.join('\n');

// 004 AMBIGUOUS
const ambiguousLines = allOutput.split('\n').filter(l => l.includes('-AMBIGUOUS]'));
const ambiguousCsv = path.join(LOGS_DIR, `004-ambiguous-${ts}.csv`);
fs.writeFileSync(ambiguousCsv, 'type,stg_user_name,stg_user_id,phone,db_name_candidate\n');
for (const line of ambiguousLines) {
  const m = line.match(/\[(.*?-AMBIGUOUS)\]\s+(.*?)\s+\(([^)]+)\)\s+→\s+phone=([^,]+),\s+name="([^"]*)",\s+후보="(.*)"/);
  if (m) fs.appendFileSync(ambiguousCsv, `${m[1]},${m[2]},${m[3]},${m[4]},"${m[6]}"\n`);
}
const ambiguousCount = ambiguousLines.length;

// 004 NAME MISMATCH
const mismatchLines = allOutput.split('\n').filter(l => /\[(PTI|BOX)\]\s/.test(l) && l.includes('후보'));
const mismatchCsv = path.join(LOGS_DIR, `004-name-mismatch-${ts}.csv`);
fs.writeFileSync(mismatchCsv, 'type,stg_user_name,stg_user_id,phone,stg_name\n');
for (const line of mismatchLines) {
  const m = line.match(/\[(PTI|BOX)\]\s+(.*?)\s+\(([^)]+)\):\s+phone=([^,]+),\s+name="([^"]*)"/);
  if (m) fs.appendFileSync(mismatchCsv, `${m[1]},${m[2]},${m[3]},${m[4]},"${m[5]}"\n`);
}
const mismatchCount = mismatchLines.length;

// 005 NO_ACCESS_CODE
const noAcLines = allOutput.split('\n').filter(l => l.includes('NO_ACCESS_CODE'));
const noAcCsv = path.join(LOGS_DIR, `005-no-access-code-${ts}.csv`);
fs.writeFileSync(noAcCsv, 'office_code,phone,unit_count\n');
for (const line of noAcLines) {
  const m = line.match(/NO_ACCESS_CODE\]\s+(\d+)\|(\S+)\s+units=(\d+)/);
  if (m) fs.appendFileSync(noAcCsv, `${m[1]},${m[2]},${m[3]}\n`);
}
const noAcCount = noAcLines.length;

// 006 NO_SMARTCUBE_ID (STG에만 존재, DB 매핑 없음)
const noIdLines = allOutput.split('\n').filter(l => l.includes('SKIP:NO_SMARTCUBE_ID'));
const noIdCsv = path.join(LOGS_DIR, `006-no-smartcube-id-${ts}.csv`);
fs.writeFileSync(noIdCsv, 'site,unitName,unitId,stgState\n');
for (const line of noIdLines) {
  const m = line.match(/NO_SMARTCUBE_ID\]\s+([^|]+)\|([^|]+)\|([^|]+)\|(.+)/);
  if (m) fs.appendFileSync(noIdCsv, `${m[1]},${m[2]},${m[3]},${m[4]}\n`);
}
const noIdCount = noIdLines.length;

// 006 DB_ONLY_OCCUPIED (STG에 rental 없지만 DB에 입주 데이터)
const dbOnlyLines = allOutput.split('\n').filter(l => l.includes('SKIP:DB_ONLY_OCCUPIED'));
const dbOnlyCsv = path.join(LOGS_DIR, `006-db-only-occupied-${ts}.csv`);
fs.writeFileSync(dbOnlyCsv, 'site,areaCode,showBoxNo,unitName,stgState,dbUserCode,dbUserName\n');
for (const line of dbOnlyLines) {
  const m = line.match(/DB_ONLY_OCCUPIED\]\s+([^|]+)\|([^|]+)\|([^|]+)\|([^|]+)\|([^|]+)\|([^|]+)\|(.+)/);
  if (m) fs.appendFileSync(dbOnlyCsv, `${m[1]},${m[2]},${m[3]},${m[4]},${m[5]},${m[6]},"${m[7]}"\n`);
}
const dbOnlyCount = dbOnlyLines.length;

// 006 FAIL:SYNC
const syncFailLines = allOutput.split('\n').filter(l => l.includes('FAIL:SYNC'));
const syncFailCsv = path.join(LOGS_DIR, `006-sync-failed-${ts}.csv`);
fs.writeFileSync(syncFailCsv, 'site,unitName,smartcubeId,error\n');
for (const line of syncFailLines) {
  const m = line.match(/FAIL:SYNC\]\s+([^|]+)\|([^|]+)\|([^|]+)\|(.+)/);
  if (m) fs.appendFileSync(syncFailCsv, `${m[1]},${m[2]},${m[3]},"${m[4]}"\n`);
}
const syncFailCount = syncFailLines.length;

// ── 보고서 생성 ──
const dbName = process.env.DB_NAME || '(unknown)';
const dbHost = process.env.DB_HOST || '(unknown)';
const dbPort = process.env.DB_PORT || '1433';
const date = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;

const report = `# 마이그레이션 보고서

- 실행일: ${date}
- 대상 DB: \`${dbName}\` (${dbHost}:${dbPort})
- 실행 방법: \`npm run migrate\`

## 결과: ${failed ? '실패' : '전체 성공'}

| 단계 | 결과 |
|------|------|
${stepResults.map(r => `| ${r.name} | ${r.status} |`).join('\n')}

## 수동 확인 필요 항목

### 004: 사용자 매핑 모호 (${ambiguousCount}건)

STG 사용자와 DB의 전화번호가 일치하나 이름이 여러 후보와 매칭됨. 수동으로 올바른 매핑을 확인해야 합니다.

파일: \`004-ambiguous-${ts}.csv\`

### 004: 이름 불일치 (${mismatchCount}건)

STG와 DB 간 이름 표기가 달라 자동 매핑되지 않은 사용자. 수동 확인 후 필요 시 DB 또는 STG에서 이름을 수정해야 합니다.

파일: \`004-name-mismatch-${ts}.csv\`

### 005: AccessCode 미설정 (${noAcCount}건)

PTI에 등록되어 있으나 AccessCode가 없는 사용자. 서버 가동 후 입주 이벤트 발생 시 자동 생성되므로 즉시 조치 불필요. 참고용.

파일: \`005-no-access-code-${ts}.csv\`

### 006: smartcube_id 미설정 (${noIdCount}건)

STG에 유닛이 존재하지만 smartcube_id가 설정되지 않아 DB와 매핑 불가. 003 단계에서 매핑되지 않은 유닛.

파일: \`006-no-smartcube-id-${ts}.csv\`

### 006: DB에만 입주 데이터 존재 (${dbOnlyCount}건)

STG에는 rental이 없지만 DB에 입주 상태(useState=1)인 유닛. 기존 호호락 데이터일 수 있으므로 동기화에서 제외됨. 수동 확인 필요.

파일: \`006-db-only-occupied-${ts}.csv\`

### 006: 동기화 실패 (${syncFailCount}건)

사이트 동기화 중 에러가 발생한 유닛. 수동 재동기화 필요.

파일: \`006-sync-failed-${ts}.csv\`

## 상세 로그

\`logs/migrate-${ts}.log\`
`;

fs.writeFileSync(reportFile, report);
log('');
log(`보고서: ${reportFile}`);
log(`CSV: ${ambiguousCsv} (${ambiguousCount}건)`);
log(`CSV: ${mismatchCsv} (${mismatchCount}건)`);
log(`CSV: ${noAcCsv} (${noAcCount}건)`);
log(`CSV: ${noIdCsv} (${noIdCount}건)`);
log(`CSV: ${dbOnlyCsv} (${dbOnlyCount}건)`);
log(`CSV: ${syncFailCsv} (${syncFailCount}건)`);

process.exit(failed ? 1 : 0);

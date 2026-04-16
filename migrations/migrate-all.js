#!/usr/bin/env node
/**
 * 전체 마이그레이션 순차 실행.
 *
 * 사용법:
 *   node migrations/migrate-all.js
 *
 * 결과물 (logs/ 폴더):
 *   - migrate-YYYYMMDD-HHmmss.log                   상세 실행 로그
 *   - migrate-YYYYMMDD-HHmmss-report.md             마이그레이션 보고서
 *   - 002-no-match-YYYYMMDD-HHmmss.csv              수동 확인: STG 유닛 ↔ DB showBoxNoDisp 매핑 실패
 *   - 003-no-owner-YYYYMMDD-HHmmss.csv              수동 확인: STG rental ownerId 누락
 *   - 005-no-smartcube-id-YYYYMMDD-HHmmss.csv       수동 확인: smartcube_id 미설정 유닛
 *   - 005-db-only-occupied-YYYYMMDD-HHmmss.csv      수동 확인: DB에만 점유 기록
 *   - 005-sync-failed-YYYYMMDD-HHmmss.csv           수동 확인: 동기화 실패 유닛
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { StringDecoder } = require('string_decoder');

const ROOT = path.join(__dirname, '..');
const LOGS_DIR = path.join(ROOT, 'logs');

// .env 로드 (DB_HOST 등 스텝 실행 전 보고서 작성에 필요)
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  fs.readFileSync(envFile, 'utf8').split('\n').forEach((line) => {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim();
  });
}

// ── CLI 인자: --offices 0001 / --offices=0001,0003 ─────────
// 파싱 후 자식 프로세스 cmd 에 그대로 `--offices <value>` 로 전달한다.
// 새 env 는 도입하지 않음. 실제 site 목록은 STG API 에서 async 로 조회해야
// 하므로 대상 지점 라벨/검증은 run() IIFE 내부에서 한다.
const { resolveSites, parseOfficesArg } = require('./lib/sites');
const CLI_OFFICES = parseOfficesArg();
// 자식 spawn 시 전달할 인자. 쉘 safe 를 위해 ' 로 감쌈.
const OFFICES_FLAG = CLI_OFFICES ? ` --offices '${CLI_OFFICES.replace(/'/g, "'\\''")}'` : '';

if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

// ── 로그 로테이션 ─────────────────────────────────────────
// 기본 30일 이상 된 migrate-* / 002-* / 003-* / 005-* 파일 제거.
// LOG_RETENTION_DAYS 환경변수로 조정 가능 (0 이면 비활성).
(function rotateLogs() {
  const retentionDays = parseInt(process.env.LOG_RETENTION_DAYS ?? '30', 10);
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return;
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const patterns = [/^migrate-\d{8}-\d{6}(\.log|-report\.md)$/, /^00[235]-.*-\d{8}-\d{6}\.csv$/];
  let removed = 0;
  for (const file of fs.readdirSync(LOGS_DIR)) {
    if (!patterns.some((p) => p.test(file))) continue;
    const fp = path.join(LOGS_DIR, file);
    try {
      const stat = fs.statSync(fp);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(fp);
        removed++;
      }
    } catch { /* ignore */ }
  }
  if (removed > 0) console.log(`[rotate] removed ${removed} old log/csv files (retention: ${retentionDays}d)`);
})();

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

// ── CSV 스트리밍 설정 ─────────────────────────────────────
// 각 CSV 는 라인 단위 streaming write 로 누적. 과거 구현은 전체 로그를
// 메모리에 담아 두고 post-process 했는데, 긴 로그에서 메모리 낭비 + 006
// 진행 상황이 실시간 안 보이는 문제가 있어 streaming 으로 변경.

const csvs = {
  noMatch: {
    path: path.join(LOGS_DIR, `002-no-match-${ts}.csv`),
    header: 'site,officeCode,unitName,unitId\n',
    // [SKIP:NO_MATCH] site|officeCode|unitName|unitId — 002 에서 STG unit 이
    // DB tblShowBoxNoDispInfo 에 매칭 안 됨 (smartcube_id 세팅 불가).
    pattern: /\[SKIP:NO_MATCH\]\s+([^|]+)\|([^|]+)\|([^|]+)\|(\S+)/,
    format: (m) => `${m[1]},${m[2]},${m[3]},${m[4]}\n`,
    count: 0,
  },
  noOwner: {
    path: path.join(LOGS_DIR, `003-no-owner-${ts}.csv`),
    header: 'site,officeCode,unitName,unitId\n',
    // [SKIP:NO_OWNER] site|officeCode|unitName|unitId
    pattern: /\[SKIP:NO_OWNER\]\s+([^|]+)\|([^|]+)\|([^|]+)\|(\S+)/,
    format: (m) => `${m[1]},${m[2]},${m[3]},${m[4]}\n`,
    count: 0,
  },
  noSmartId: {
    path: path.join(LOGS_DIR, `005-no-smartcube-id-${ts}.csv`),
    header: 'site,unitName,unitId,stgState\n',
    pattern: /SKIP:NO_SMARTCUBE_ID\]\s+([^|]+)\|([^|]+)\|([^|]+)\|(.+)/,
    format: (m) => `${m[1]},${m[2]},${m[3]},${m[4]}\n`,
    count: 0,
  },
  dbOnly: {
    path: path.join(LOGS_DIR, `005-db-only-occupied-${ts}.csv`),
    header: 'site,areaCode,showBoxNo,unitName,stgState,dbUseState,dbUserCode,dbUserName\n',
    pattern: /SKIP:DB_ONLY_OCCUPIED\]\s+([^|]+)\|([^|]+)\|([^|]+)\|([^|]+)\|([^|]+)\|useState=([^|]+)\|([^|]+)\|(.+)/,
    format: (m) => `${m[1]},${m[2]},${m[3]},${m[4]},${m[5]},${m[6]},${m[7]},"${m[8]}"\n`,
    count: 0,
  },
  syncFail: {
    path: path.join(LOGS_DIR, `005-sync-failed-${ts}.csv`),
    header: 'site,unitName,smartcubeId,error\n',
    pattern: /FAIL:SYNC\]\s+([^|]+)\|([^|]+)\|([^|]+)\|(.+)/,
    format: (m) => `${m[1]},${m[2]},${m[3]},"${m[4]}"\n`,
    count: 0,
  },
};

// 로그/CSV writeStream 열기
const logStream = fs.createWriteStream(logFile, { flags: 'w' });
const csvStreams = {};
for (const [key, cfg] of Object.entries(csvs)) {
  const s = fs.createWriteStream(cfg.path, { flags: 'w' });
  s.write(cfg.header);
  csvStreams[key] = s;
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  logStream.write(line + '\n');
}

// 자식 프로세스 라인을 CSV 패턴에 대조해 누적.
// 복수 패턴이 매칭될 수 없음 (각 패턴이 상호 배타적인 태그를 포함).
function extractCsv(line) {
  for (const [key, cfg] of Object.entries(csvs)) {
    const m = line.match(cfg.pattern);
    if (m) {
      csvStreams[key].write(cfg.format(m));
      cfg.count++;
      return;
    }
  }
}

// ── 스텝 실행 (spawn + streaming tee) ──────────────────────
function runStep(step, idx, total) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    log(`[${idx + 1}/${total}] ${step.name} 실행 중...`);

    const child = spawn(step.cmd, {
      cwd: ROOT,
      env: { ...process.env },
      shell: true,
    });

    // stdout/stderr 모두 라인 버퍼링 후 tee.
    // chunk 경계가 라인 중간에 걸리므로 트레일링 부분을 다음 chunk 까지 보관.
    // UTF-8 멀티바이트 문자가 chunk 경계에서 쪼개지지 않도록 StringDecoder 사용.
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    const stdoutRef = { value: '' };
    const stderrRef = { value: '' };

    const emitLine = (raw) => {
      if (raw === '') return;
      const indented = `  ${raw}`;
      console.log(indented);
      logStream.write(indented + '\n');
      extractCsv(raw);
    };

    const handleChunk = (chunk, decoder, tailRef) => {
      const text = decoder.write(chunk);
      const combined = tailRef.value + text;
      const parts = combined.split('\n');
      tailRef.value = parts.pop();
      for (const raw of parts) emitLine(raw);
    };

    child.stdout.on('data', (c) => handleChunk(c, stdoutDecoder, stdoutRef));
    child.stderr.on('data', (c) => handleChunk(c, stderrDecoder, stderrRef));

    child.on('close', (code) => {
      // decoder 잔여분 flush
      const stdoutFlush = stdoutDecoder.end();
      if (stdoutFlush) stdoutRef.value += stdoutFlush;
      const stderrFlush = stderrDecoder.end();
      if (stderrFlush) stderrRef.value += stderrFlush;

      // 남은 트레일링 라인 flush
      if (stdoutRef.value) emitLine(stdoutRef.value);
      if (stderrRef.value) emitLine(stderrRef.value);

      const durationSec = ((Date.now() - startedAt) / 1000).toFixed(1);
      if (code === 0) {
        log(`[${idx + 1}/${total}] ${step.name} — 완료 (${durationSec}s)`);
        resolve({ ok: true });
      } else {
        log(`[${idx + 1}/${total}] ${step.name} — 실패 (exit ${code}, ${durationSec}s)`);
        resolve({ ok: false, code });
      }
    });

    child.on('error', (err) => {
      log(`[${idx + 1}/${total}] ${step.name} — spawn 에러: ${err.message}`);
      resolve({ ok: false, code: -1 });
    });
  });
}

const steps = [
  { name: '001 스키마 생성', cmd: `node migrations/run-sql.js migrations/001-init-schema.sql` },
  { name: '002 STG 유닛 ID 매핑', cmd: `DRY_RUN=false node migrations/002-upsert-unit-smartcube-ids.js${OFFICES_FLAG}` },
  { name: '003 STG 사용자 ID 매핑', cmd: `DRY_RUN=false node migrations/003-migrate-stg-user-ids.js${OFFICES_FLAG}` },
  { name: '004 PTI 정합성 보정', cmd: `DRY_RUN=false node migrations/004-reconcile-pti-per-unit.js${OFFICES_FLAG}` },
  { name: '005 전체 사이트 동기화', cmd: `DRY_RUN=false node migrations/005-site-sync.js${OFFICES_FLAG}` },
];

(async () => {
  // STG 에서 site 목록 조회해 대상 지점 라벨 생성. customFields.smartcube_siteCode
  // 가 없는 site 나 알 수 없는 officeCode 가 --offices 에 포함되면 여기서 throw.
  let TARGET_OFFICES_LABEL;
  try {
    const TARGET_SITES = await resolveSites(CLI_OFFICES);
    TARGET_OFFICES_LABEL = CLI_OFFICES
      ? TARGET_SITES.map((s) => `${s.officeCode}(${s.name})`).join(', ')
      : TARGET_SITES.map((s) => `${s.officeCode}(${s.name})`).join(', ') + ' (전체)';
  } catch (err) {
    console.error(`[FATAL] 대상 지점 확인 실패: ${err.message}`);
    process.exit(1);
  }

  log(`마이그레이션 시작 (${steps.length}단계)`);
  log(`대상 지점: ${TARGET_OFFICES_LABEL}`);
  log(`로그 파일: ${logFile}`);
  log('');

  const stepResults = [];
  let failed = false;
  for (let i = 0; i < steps.length; i++) {
    const r = await runStep(steps[i], i, steps.length);
    if (r.ok) {
      stepResults.push({ name: steps[i].name, status: '완료' });
    } else {
      stepResults.push({ name: steps[i].name, status: '실패' });
      failed = true;
      log('');
      log('마이그레이션 중단. 이전 단계까지는 적용됨.');
      break;
    }
    log('');
  }

  if (!failed) log('전체 마이그레이션 완료.');

  // CSV 스트림 닫기 (보고서에서 파일 참조 전에 flush 보장)
  await Promise.all(
    Object.values(csvStreams).map((s) => new Promise((r) => s.end(r))),
  );

  // ── 보고서 생성 ────────────────────────────────────────
  const dbName = process.env.DB_NAME || '(unknown)';
  const dbHost = process.env.DB_HOST || '(unknown)';
  const dbPort = process.env.DB_PORT || '1433';
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  const report = `# 마이그레이션 보고서

- 실행일: ${date}
- 대상 DB: \`${dbName}\` (${dbHost}:${dbPort})
- 대상 지점: ${TARGET_OFFICES_LABEL}
- 실행 방법: \`npm run migrate${CLI_OFFICES ? ` -- --offices ${CLI_OFFICES}` : ''}\`

## 결과: ${failed ? '실패' : '전체 성공'}

| 단계 | 결과 |
|------|------|
${stepResults.map((r) => `| ${r.name} | ${r.status} |`).join('\n')}

## 수동 확인 필요 항목

### 002: DB 매핑 실패 (${csvs.noMatch.count}건)

STG 유닛이 존재하지만 DB \`tblShowBoxNoDispInfo\` 에 매칭되는 \`showBoxNoDisp\` 가 없어 \`smartcube_id\` 를 세팅할 수 없음. 운영자 수동 확인 필요.

파일: \`002-no-match-${ts}.csv\`

### 003: rental ownerId 누락 (${csvs.noOwner.count}건)

STG occupied 유닛에 rental.ownerId 가 없어 StgUserId 를 세팅할 수 없음. STG 데이터 이슈로 STG 측 확인 필요.

파일: \`003-no-owner-${ts}.csv\`

### 005: smartcube_id 미설정 (${csvs.noSmartId.count}건)

STG 에 유닛이 존재하지만 smartcube_id 가 설정되지 않아 DB 와 매핑 불가. 002 단계에서 매핑되지 않은 유닛.

파일: \`005-no-smartcube-id-${ts}.csv\`

### 005: DB 에만 입주 데이터 존재 (${csvs.dbOnly.count}건)

STG 에는 rental 이 없지만 DB 에 점거 상태(useState=1 정상 입주 또는 useState=3 차단)인 유닛. 기존 호호락 데이터일 수 있으므로 동기화에서 제외됨. 수동 확인 필요.

파일: \`005-db-only-occupied-${ts}.csv\`

### 005: 동기화 실패 (${csvs.syncFail.count}건)

사이트 동기화 중 에러가 발생한 유닛. 수동 재동기화 필요.

파일: \`005-sync-failed-${ts}.csv\`

## 상세 로그

\`logs/migrate-${ts}.log\`
`;

  fs.writeFileSync(reportFile, report);
  log('');
  log(`보고서: ${reportFile}`);
  for (const [, cfg] of Object.entries(csvs)) {
    log(`CSV: ${cfg.path} (${cfg.count}건)`);
  }

  // 로그 스트림 닫기
  logStream.end();
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});

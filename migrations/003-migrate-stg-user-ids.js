#!/usr/bin/env node
/**
 * 003: STG User ID 매핑 스크립트 (rental 기반)
 *
 * STG 사이트별 유닛을 순회하며, occupied 유닛의 rental.ownerId를
 * tblPTIUserInfo.StgUserId 및 tblBoxMaster.userCode에 세팅합니다.
 *
 * rental.ownerId를 source of truth로 사용하므로 005 site-sync 와 동일한
 * stgUserId 가 세팅됩니다. 이를 통해 005 sync 시 findExistingAccessCode 가
 * 기존 AccessCode 를 찾아 재사용할 수 있습니다.
 *
 * 사용법:
 *   node migrations/003-migrate-stg-user-ids.js                            # dry-run
 *   DRY_RUN=false node migrations/003-migrate-stg-user-ids.js              # 실제 실행
 *   DRY_RUN=false node migrations/003-migrate-stg-user-ids.js --offices 001  # 지점 제한
 *
 * 환경변수:
 *   DRY_RUN   - true(기본) / false
 *   ENV_PATH  - .env 파일 경로 (기본: sync-server/.env)
 */

const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');

const sql = require('mssql');
const { resolveSites, parseOfficesArg } = require('./lib/sites');
const SITES = resolveSites(parseOfficesArg());

// ─── .env 로드 ───────────────────────────────────────────

function loadEnv() {
  const envPath =
    process.env.ENV_PATH ||
    path.join(__dirname, '..', '.env');

  if (!fs.existsSync(envPath)) {
    throw new Error(`.env 파일을 찾을 수 없습니다: ${envPath}`);
  }

  // .env 파일값은 shell env 에 이미 설정돼있지 않은 경우에만 process.env 에 주입.
  // 이 순서가 깨지면 shell override (예: DB_HOST=localhost) 가 먹히지 않아
  // test DB 격리가 불가능해지고 prod 에 잘못 쿼리가 꽂힐 수 있다.
  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
  return process.env;
}

// ─── 유틸리티 ────────────────────────────────────────────

function normalizePhone(sgPhone) {
  if (!sgPhone) return '';
  const digits = sgPhone.replace(/\D/g, '');
  if (digits.startsWith('82')) {
    const tail = digits.slice(2);
    return tail.startsWith('0') ? tail : '0' + tail;
  }
  if (/^10\d{8}$/.test(digits)) {
    return '0' + digits;
  }
  return digits;
}

function formatName(lastName, firstName) {
  const last = (lastName ?? '').trim();
  const first = (firstName ?? '').trim();
  if (last && first) return `${last}, ${first}`;
  return last || first || '';
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

// ─── HTTP 헬퍼 ───────────────────────────────────────────

function httpGetOnce(url, apiKey) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, {
      headers: { Authorization: `ApiKey ${apiKey}` },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        const status = res.statusCode || 0;
        if (status >= 200 && status < 300) {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error(`JSON parse error: ${data.slice(0, 200)}`));
          }
        } else {
          const err = new Error(`STG HTTP ${status}: ${data.slice(0, 200)}`);
          err.status = status;
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('request timeout')));
  });
}

// STG API 재시도 wrapper.
// 429/5xx/네트워크 에러는 exponential backoff 로 최대 MAX_RETRIES 회 재시도.
async function httpGet(url, apiKey) {
  const MAX_RETRIES = 5;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await httpGetOnce(url, apiKey);
    } catch (err) {
      lastErr = err;
      const msg = err.message || '';
      const status = err.status || 0;
      const isRetryable =
        status === 429 ||
        (status >= 500 && status < 600) ||
        /ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up|timeout/i.test(msg);
      if (!isRetryable || attempt === MAX_RETRIES) throw err;
      const delay = status === 429 ? 2000 * attempt : 300 * attempt;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

async function fetchAllUnitsForSite(baseUrl, apiKey, siteId) {
  const LIMIT = 1000;
  const all = [];
  let offset = 0;
  for (;;) {
    const url = `${baseUrl}/v1/admin/units?siteId=${siteId}&include=customFields&limit=${LIMIT}&offset=${offset}`;
    const data = await httpGet(url, apiKey);
    if (!Array.isArray(data)) {
      throw new Error(`STG 유닛 조회 실패 (siteId=${siteId}): 응답이 배열이 아님`);
    }
    if (data.length === 0) break;
    all.push(...data);
    if (data.length < LIMIT) break;
    offset += LIMIT;
  }
  return all;
}

// ─── 메인 ─────────────────────────────────────────────────

async function main() {
  const DRY_RUN = (process.env.DRY_RUN ?? 'true') !== 'false';
  const env = loadEnv();

  console.log('=== 003: STG User ID 매핑 (rental 기반) ===');
  console.log(`DRY_RUN=${DRY_RUN}`);
  console.log('');

  // ── 1. MSSQL 연결 ──
  const pool = await sql.connect({
    server: env.DB_HOST,
    port: parseInt(env.DB_PORT),
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_NAME,
    options: {
      encrypt: false,
      trustServerCertificate: true,
      tdsVersion: '7_1',
    },
  });

  try {
    // ── 2. StgUserId 컬럼 존재 확인 ──
    const colCheck = await pool.request().query(`
      SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_NAME = 'tblPTIUserInfo' AND COLUMN_NAME = 'StgUserId'
    `);
    if (colCheck.recordset.length === 0) {
      throw new Error(
        'tblPTIUserInfo.StgUserId 컬럼이 없습니다. 먼저 001-init-schema.sql을 실행하세요.',
      );
    }
    console.log('✓ tblPTIUserInfo.StgUserId 컬럼 확인됨');

    const stats = {
      total: 0, occupied: 0, mapped: 0, noSmartcubeId: 0,
      notOccupied: 0, noOwnerId: 0, userFetchFail: 0,
      ptiUpdated: 0, boxUpdated: 0,
    };

    // ── 3. user 캐시 (ownerId → { phone, name }) ──
    const userCache = new Map();

    async function getUser(ownerId) {
      if (userCache.has(ownerId)) return userCache.get(ownerId);
      const url = `${env.SG_BASE_URL}/v1/admin/users/${ownerId}`;
      const user = await httpGet(url, env.SG_API_KEY);
      const phone = normalizePhone(user.phone || user.mobile || '');
      const name = formatName(user.lastName, user.firstName);
      const info = { phone, name, rawName: user.name || '' };
      userCache.set(ownerId, info);
      return info;
    }

    // ── 4. 사이트별 유닛 순회 ──
    for (const site of SITES) {
      console.log(`\n=== [${site.name}] officeCode=${site.officeCode} ===`);

      const units = await fetchAllUnitsForSite(env.SG_BASE_URL, env.SG_API_KEY, site.siteId);
      console.log(`  STG 유닛: ${units.length}개`);

      let done = 0;
      for (const unit of units) {
        stats.total++;
        done++;
        if (done % 50 === 0 || done === units.length) {
          console.log(`  진행: ${done}/${units.length} (occupied ${stats.occupied}, mapped ${stats.mapped})`);
        }
        const unitName = unit.name || unit.id;

        // smartcube_id 확인
        const smartcubeId = unit.customFields?.smartcube_id;
        const parsed = parseSmartcubeId(smartcubeId);
        if (!parsed) {
          stats.noSmartcubeId++;
          continue;
        }

        // occupied + rentalId 확인
        const stgState = (unit.state || '').toLowerCase();
        if (stgState !== 'occupied' || !unit.rentalId) {
          stats.notOccupied++;
          continue;
        }

        stats.occupied++;

        // rental → ownerId
        let rental;
        try {
          const rentalUrl = `${env.SG_BASE_URL}/v1/admin/unit-rentals/${unit.rentalId}?include=customFields`;
          rental = await httpGet(rentalUrl, env.SG_API_KEY);
        } catch (err) {
          console.log(`  [FAIL:RENTAL] ${unitName}: ${err.message}`);
          stats.userFetchFail++;
          continue;
        }

        const ownerId = rental.ownerId;
        if (!ownerId) {
          stats.noOwnerId++;
          console.log(`  [SKIP:NO_OWNER] ${site.name}|${site.officeCode}|${unitName}|${unit.id}`);
          continue;
        }

        // user 정보 조회 (캐시)
        let userInfo;
        try {
          userInfo = getUser(ownerId);
          if (userInfo instanceof Promise) userInfo = await userInfo;
        } catch (err) {
          console.log(`  [FAIL:USER] ${unitName}: ${err.message}`);
          stats.userFetchFail++;
          continue;
        }

        // DB 유닛 매핑
        const areaPrefix = site.officeCode.replace(/^0/, '');
        const areaCode = 'strh' + areaPrefix + parsed.groupCode;

        if (DRY_RUN) {
          console.log(`  [MAP] ${unitName} → ${areaCode}:${parsed.showBoxNo} owner=${ownerId} (${userInfo.rawName})`);
        } else {
          // tblPTIUserInfo: (AreaCode, showBoxNo) 기준으로 StgUserId 세팅
          const ptiResult = await pool.request()
            .input('stgUserId', sql.NVarChar, ownerId)
            .input('areaCode', sql.NVarChar, areaCode)
            .input('showBoxNo', sql.Int, parsed.showBoxNo)
            .query(
              `UPDATE tblPTIUserInfo SET StgUserId = @stgUserId, UpdateTime = GETDATE()
               WHERE AreaCode = @areaCode AND showBoxNo = @showBoxNo
                 AND (StgUserId IS NULL OR StgUserId = '' OR StgUserId <> @stgUserId)`,
            );
          stats.ptiUpdated += ptiResult.rowsAffected[0];

          // tblBoxMaster: (areaCode, showBoxNo) 기준으로 userCode 세팅
          const boxResult = await pool.request()
            .input('stgUserId', sql.NVarChar, ownerId)
            .input('areaCode', sql.NVarChar, areaCode)
            .input('showBoxNo', sql.Int, parsed.showBoxNo)
            .query(
              `UPDATE tblBoxMaster SET userCode = @stgUserId, updateTime = GETDATE()
               WHERE areaCode = @areaCode AND showBoxNo = @showBoxNo
                 AND (userCode IS NULL OR userCode = '' OR userCode <> @stgUserId)`,
            );
          stats.boxUpdated += boxResult.rowsAffected[0];
        }

        stats.mapped++;
      }
    }

    // ── 5. 결과 리포트 ──
    console.log('');
    console.log('=========================================');
    console.log(`총 유닛: ${stats.total}`);
    console.log(`  occupied: ${stats.occupied}`);
    console.log(`  매핑 성공: ${stats.mapped}`);
    console.log(`  not occupied (available/reserved): ${stats.notOccupied}`);
    console.log(`  smartcube_id 없음: ${stats.noSmartcubeId}`);
    console.log(`  ownerId 없음: ${stats.noOwnerId}`);
    console.log(`  조회 실패 (rental/user): ${stats.userFetchFail}`);
    console.log('');
    console.log(`DB 업데이트:`);
    console.log(`  tblPTIUserInfo: ${stats.ptiUpdated}행`);
    console.log(`  tblBoxMaster: ${stats.boxUpdated}행`);
    console.log(`  user 캐시: ${userCache.size}명 (중복 조회 절감)`);

    if (DRY_RUN) {
      console.log('');
      console.log(`DRY-RUN 완료. 실제 실행: DRY_RUN=false node ${path.relative(process.cwd(), process.argv[1])}`);
    } else {
      console.log('');
      console.log('실행 완료.');
    }
  } finally {
    await pool.close();
  }
}

main().catch((err) => {
  console.error('FATAL:', err.message || err);
  process.exit(1);
});

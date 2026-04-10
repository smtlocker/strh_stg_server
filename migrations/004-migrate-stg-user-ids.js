#!/usr/bin/env node
/**
 * 003: STG User ID 매핑 스크립트
 *
 * STG API에서 사용자 목록을 가져와 phone + name 기준으로
 * tblPTIUserInfo.StgUserId 및 tblBoxMaster.userCode를 업데이트합니다.
 *
 * 사용법:
 *   node migrations/003-migrate-stg-user-ids.js                # dry-run (변경 없이 확인)
 *   DRY_RUN=false node migrations/003-migrate-stg-user-ids.js  # 실제 실행
 *
 * 환경변수:
 *   DRY_RUN   - true(기본) / false
 *   ENV_PATH  - .env 파일 경로 (기본: sync-server/.env)
 *
 * 프로덕션 실행 시:
 *   ENV_PATH=/path/to/prod.env DRY_RUN=false node migrations/003-migrate-stg-user-ids.js
 */

const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');

const sql = require('mssql');

// ─── .env 로드 ───────────────────────────────────────────

function loadEnv() {
  const envPath =
    process.env.ENV_PATH ||
    path.join(__dirname, '..', '.env');

  if (!fs.existsSync(envPath)) {
    throw new Error(`.env 파일을 찾을 수 없습니다: ${envPath}`);
  }

  const content = fs.readFileSync(envPath, 'utf8');
  const env = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    env[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
  }
  return env;
}

// ─── 유틸리티 (sync-server/src/common/utils.ts 동일 로직) ──

function normalizePhone(sgPhone) {
  if (!sgPhone) return '';
  const digits = sgPhone.replace(/\D/g, '');
  if (digits.startsWith('82')) {
    return '0' + digits.slice(2);
  }
  return digits;
}

function formatName(lastName, firstName) {
  const last = (lastName ?? '').trim();
  const first = (firstName ?? '').trim();
  if (last && first) return `${last}, ${first}`;
  return last || first || '';
}

// ─── HTTP 헬퍼 ───────────────────────────────────────────

function httpGet(url, apiKey) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, {
      headers: { Authorization: `ApiKey ${apiKey}` },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error(`JSON parse error: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
  });
}

async function fetchAllStgUsers(baseUrl, apiKey) {
  // STG API는 skip을 지원하지 않고 limit 최대 1000
  // limit=1000으로 한 번에 조회 후 ID 기준 중복 제거
  const url = `${baseUrl}/v1/admin/users?limit=1000&include=customFields`;
  const data = await httpGet(url, apiKey);

  if (!Array.isArray(data)) {
    throw new Error('STG 사용자 조회 실패: 응답이 배열이 아님');
  }

  // ID 기준 중복 제거
  const seen = new Set();
  return data.filter((u) => {
    if (seen.has(u.id)) return false;
    seen.add(u.id);
    return true;
  });
}

// ─── 메인 ─────────────────────────────────────────────────

async function main() {
  const DRY_RUN = (process.env.DRY_RUN ?? 'true') !== 'false';
  const env = loadEnv();

  console.log('=== 003: STG User ID 매핑 ===');
  console.log(`DRY_RUN=${DRY_RUN} (실제 실행: DRY_RUN=false node ${path.relative(process.cwd(), process.argv[1])})`);
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
        'tblPTIUserInfo.StgUserId 컬럼이 없습니다. 먼저 003-add-stg-user-id-column.sql을 실행하세요.',
      );
    }
    console.log('✓ tblPTIUserInfo.StgUserId 컬럼 확인됨');

    // ── 3. STG 사용자 전체 조회 ──
    console.log('STG 사용자 목록 조회 중...');
    const stgUsers = await fetchAllStgUsers(env.SG_BASE_URL, env.SG_API_KEY);
    console.log(`STG 사용자 수: ${stgUsers.length}`);

    // ── 4. MSSQL 현재 데이터 조회 ──
    const ptiResult = await pool.request().query(
      'SELECT UserPhone, UserName, AreaCode, showBoxNo, StgUserId FROM tblPTIUserInfo',
    );
    const ptiRows = ptiResult.recordset;
    console.log(`tblPTIUserInfo 행 수: ${ptiRows.length}`);

    const boxResult = await pool.request().query(`
      SELECT areaCode, boxNo, userPhone, userName, userCode
      FROM tblBoxMaster
      WHERE userPhone IS NOT NULL AND userPhone != ''
    `);
    const boxRows = boxResult.recordset;
    console.log(`tblBoxMaster (사용자 있는 유닛) 행 수: ${boxRows.length}`);
    console.log('');

    // ── 5. 매핑 실행 ──
    const stats = {
      pti: { matched: 0, rows: 0, ambiguous: 0, noPhone: 0, noMatch: 0 },
      box: { matched: 0, rows: 0, ambiguous: 0, noMatch: 0 },
    };
    const ambiguousLog = [];

    for (const user of stgUsers) {
      const phone = normalizePhone(user.phone);
      const name = formatName(user.lastName, user.firstName);
      const label = `${user.name} (${user.id})`;

      if (!phone) {
        stats.pti.noPhone++;
        console.log(`  [SKIP] ${label}: 전화번호 없음`);
        continue;
      }

      // ── tblPTIUserInfo 매핑 ──
      const ptiCandidates = ptiRows.filter((r) => r.UserPhone === phone);

      if (ptiCandidates.length === 0) {
        stats.pti.noMatch++;
      } else {
        // phone+name 으로 매칭
        const nameMatches = ptiCandidates.filter((r) => r.UserName === name);
        const targets = nameMatches.length > 0 ? nameMatches : null;

        if (targets) {
          if (DRY_RUN) {
            console.log(`  [PTI] ${label} → phone=${phone}, name="${name}" ✓ (${targets.length}행)`);
          } else {
            await pool.request()
              .input('stgUserId', sql.NVarChar, user.id)
              .input('userPhone', sql.NVarChar, phone)
              .input('userName', sql.NVarChar, name)
              .query(
                'UPDATE tblPTIUserInfo SET StgUserId = @stgUserId WHERE UserPhone = @userPhone AND UserName = @userName',
              );
          }
          stats.pti.matched++;
          stats.pti.rows += targets.length;
        } else {
          const detail = `phone=${phone}, name="${name}", 후보=${ptiCandidates.map((r) => `"${r.UserName}"`).join(',')}`;
          console.log(`  [PTI-AMBIGUOUS] ${label} → ${detail}`);
          ambiguousLog.push({ table: 'PTI', user: label, phone, name, candidates: ptiCandidates.length });
          stats.pti.ambiguous++;
        }
      }

      // ── tblBoxMaster 매핑 ──
      const boxCandidates = boxRows.filter((r) => r.userPhone === phone);

      if (boxCandidates.length === 0) {
        stats.box.noMatch++;
      } else {
        // phone+name 으로 매칭
        const nameMatches = boxCandidates.filter((r) => r.userName === name);
        const targets = nameMatches.length > 0 ? nameMatches : null;

        if (targets) {
          for (const box of targets) {
            if (DRY_RUN) {
              console.log(`  [BOX] ${label} → phone=${phone}, box=${box.areaCode}:${box.boxNo} ✓`);
            } else {
              await pool.request()
                .input('stgUserId', sql.NVarChar, user.id)
                .input('areaCode', sql.NVarChar, box.areaCode)
                .input('boxNo', sql.Int, box.boxNo)
                .query(
                  'UPDATE tblBoxMaster SET userCode = @stgUserId WHERE areaCode = @areaCode AND boxNo = @boxNo',
                );
            }
          }
          stats.box.matched++;
          stats.box.rows += targets.length;
        } else {
          const detail = `phone=${phone}, name="${name}", 후보=${boxCandidates.map((r) => `"${r.userName}"`).join(',')}`;
          console.log(`  [BOX-AMBIGUOUS] ${label} → ${detail}`);
          ambiguousLog.push({ table: 'BOX', user: label, phone, name, candidates: boxCandidates.length });
          stats.box.ambiguous++;
        }
      }
    }

    // ── 6. 결과 리포트 ──
    console.log('');
    console.log('=========================================');
    console.log('tblPTIUserInfo:');
    console.log(`  매칭 성공: ${stats.pti.matched}명 (${stats.pti.rows}행 업데이트)`);
    console.log(`  매칭 실패 (이름 불일치): ${stats.pti.ambiguous}명`);
    console.log(`  MSSQL에 없음: ${stats.pti.noMatch}명`);
    console.log(`  전화번호 없음: ${stats.pti.noPhone}명`);
    console.log('');
    console.log('tblBoxMaster:');
    console.log(`  매칭 성공: ${stats.box.matched}명 (${stats.box.rows}행 업데이트)`);
    console.log(`  매칭 실패 (이름 불일치): ${stats.box.ambiguous}명`);
    console.log(`  MSSQL에 없음: ${stats.box.noMatch}명`);

    if (ambiguousLog.length > 0) {
      console.log('');
      console.log('--- 수동 확인 필요 (AMBIGUOUS) ---');
      for (const a of ambiguousLog) {
        console.log(`  [${a.table}] ${a.user}: phone=${a.phone}, name="${a.name}" (후보 ${a.candidates}건)`);
      }
    }

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

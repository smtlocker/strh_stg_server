#!/usr/bin/env node
/* eslint-disable */
// 범용 SQL 파일 실행 헬퍼 (재사용 가능).
// usql은 T-SQL IF/BEGIN/END 블록을 파싱하지 못해 migration 파일 실행이 안 된다.
// 이 스크립트는 `GO` separator로 batch를 분할해 각 batch를 mssql.query()로 실행한다.
//
// 사용법:
//   node scripts/run-sql.js path/to/file.sql
//   echo "SELECT 1" | node scripts/run-sql.js   (stdin)
const fs = require('fs');
const path = require('path');
const sql = require('mssql');

const env = {};
fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8')
  .split('\n')
  .forEach((l) => {
    const m = l.match(/^([^#=][^=]*)=(.*)$/);
    if (m) env[m[1].trim()] = m[2].trim();
  });

async function main() {
  const arg = process.argv[2];
  let content;
  if (arg && arg !== '-') {
    content = fs.readFileSync(arg, 'utf8');
    console.log(`[run-sql] executing ${arg}`);
  } else {
    content = fs.readFileSync(0, 'utf8');
    console.log('[run-sql] executing stdin');
  }

  // GO를 batch separator로 분할 (한 줄에 GO만 있는 경우)
  const batches = content
    .split(/^[\t ]*GO[\t ]*$/mi)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);

  console.log(`[run-sql] ${batches.length} batch(es) detected`);

  const pool = await sql.connect({
    server: env.DB_HOST,
    port: parseInt(env.DB_PORT, 10),
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_NAME,
    options: { encrypt: false, trustServerCertificate: true },
  });

  let batchIdx = 0;
  for (const batch of batches) {
    batchIdx++;
    try {
      const result = await pool.request().batch(batch);
      // PRINT 메시지는 pool.on('info')에서만 받을 수 있음. 간단히 row 수만 보고.
      if (result.rowsAffected && result.rowsAffected.length > 0) {
        console.log(`  [batch ${batchIdx}] rows affected: ${result.rowsAffected.join(',')}`);
      } else {
        console.log(`  [batch ${batchIdx}] OK`);
      }
      if (Array.isArray(result.recordsets)) {
        result.recordsets.forEach((rs) => {
          if (rs && rs.length > 0) console.table(rs);
        });
      }
    } catch (err) {
      console.error(`  [batch ${batchIdx}] FAIL: ${err.message}`);
      console.error(`  --- batch SQL (first 200 chars) ---`);
      console.error(batch.slice(0, 200));
      await pool.close();
      process.exit(1);
    }
  }

  await pool.close();
  console.log('[run-sql] done');
}

// PRINT 메시지 전달용
sql.on && sql.on('info', (msg) => console.log(`[mssql:info] ${msg.message}`));

main().catch((e) => {
  console.error('[FATAL]', e);
  process.exit(1);
});

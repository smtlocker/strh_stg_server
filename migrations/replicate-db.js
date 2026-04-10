#!/usr/bin/env node
/**
 * 원격 DB → 로컬 Docker MSSQL 복제.
 * 대형 테이블은 청크 단위로 복제하여 메모리 초과를 방지.
 */
const sql = require('mssql');
const path = require('path');

// .env 로드
const fs = require('fs');
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) process.env[match[1].trim()] = match[2].trim();
  });
}

const SOURCE_DB = process.env.REPLICATE_SOURCE_DB || 'HOHO_LOCK_STRH_20260408';
const TARGET_DB = process.env.REPLICATE_TARGET_DB || 'HOHO_LOCK_STRH_MIGRATE_TEST';
const CHUNK_SIZE = 10000;

const REMOTE_CFG = {
  server: process.env.DB_HOST, port: parseInt(process.env.DB_PORT || '1433'),
  user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  database: SOURCE_DB,
  options: { encrypt: false, trustServerCertificate: true },
  pool: { max: 3 },
  requestTimeout: 120000,
};
const LOCAL_CFG = {
  server: 'localhost', port: 1433,
  user: 'sa', password: 'MigrateTest1!',
  database: TARGET_DB,
  options: { encrypt: false, trustServerCertificate: true },
  pool: { max: 3 },
  requestTimeout: 120000,
};

function mapType(c) {
  switch (c.DATA_TYPE) {
    case 'int': return sql.Int;
    case 'bigint': return sql.BigInt;
    case 'smallint': return sql.SmallInt;
    case 'tinyint': return sql.TinyInt;
    case 'bit': return sql.Bit;
    case 'float': return sql.Float;
    case 'real': return sql.Real;
    case 'decimal': case 'numeric': return sql.Decimal(c.NUMERIC_PRECISION, c.NUMERIC_SCALE);
    case 'datetime': return sql.DateTime;
    case 'datetime2': return sql.DateTime2;
    case 'date': return sql.Date;
    case 'nvarchar': return c.CHARACTER_MAXIMUM_LENGTH === -1 ? sql.NVarChar(sql.MAX) : sql.NVarChar(c.CHARACTER_MAXIMUM_LENGTH);
    case 'varchar': return c.CHARACTER_MAXIMUM_LENGTH === -1 ? sql.VarChar(sql.MAX) : sql.VarChar(c.CHARACTER_MAXIMUM_LENGTH);
    case 'nchar': return sql.NChar(c.CHARACTER_MAXIMUM_LENGTH);
    case 'char': return sql.Char(c.CHARACTER_MAXIMUM_LENGTH);
    case 'text': return sql.Text;
    case 'ntext': return sql.NText;
    case 'image': return sql.Image;
    case 'varbinary': return c.CHARACTER_MAXIMUM_LENGTH === -1 ? sql.VarBinary(sql.MAX) : sql.VarBinary(c.CHARACTER_MAXIMUM_LENGTH);
    default: return sql.NVarChar(sql.MAX);
  }
}

function colDef(c) {
  let type = c.DATA_TYPE;
  if (['varchar','nvarchar','char','nchar'].includes(type)) {
    type += '(' + (c.CHARACTER_MAXIMUM_LENGTH === -1 ? 'MAX' : c.CHARACTER_MAXIMUM_LENGTH) + ')';
  } else if (['decimal','numeric'].includes(type)) {
    type += '(' + c.NUMERIC_PRECISION + ',' + c.NUMERIC_SCALE + ')';
  }
  return '[' + c.COLUMN_NAME + '] ' + type + ' ' + (c.IS_NULLABLE === 'YES' ? 'NULL' : 'NOT NULL');
}

(async () => {
  const remote = new sql.ConnectionPool(REMOTE_CFG);
  await remote.connect();
  const local = new sql.ConnectionPool(LOCAL_CFG);
  await local.connect();

  const tables = await remote.request().query(
    "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME"
  );
  console.log(`[복제] ${SOURCE_DB} → ${TARGET_DB} (${tables.recordset.length} tables)\n`);

  for (const { TABLE_NAME } of tables.recordset) {
    const cols = await remote.request().query(
      `SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, IS_NULLABLE, NUMERIC_PRECISION, NUMERIC_SCALE
       FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = '${TABLE_NAME}' ORDER BY ORDINAL_POSITION`
    );

    // CREATE TABLE
    await local.request().query('CREATE TABLE [' + TABLE_NAME + '] (' + cols.recordset.map(colDef).join(', ') + ')');

    // row count
    const cntResult = await remote.request().query('SELECT COUNT(*) as cnt FROM [' + TABLE_NAME + ']');
    const totalRows = cntResult.recordset[0].cnt;

    if (totalRows === 0) {
      console.log(`  ${TABLE_NAME}: 0 rows (스키마만)`);
      continue;
    }

    // 청크 복제
    let copied = 0;
    while (copied < totalRows) {
      const data = await remote.request().query(
        `SELECT * FROM (SELECT *, ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS __rn FROM [${TABLE_NAME}]) t WHERE __rn > ${copied} AND __rn <= ${copied + CHUNK_SIZE}`
      );
      if (data.recordset.length === 0) break;

      const table = new sql.Table(TABLE_NAME);
      table.create = false;
      cols.recordset.forEach(c => {
        table.columns.add(c.COLUMN_NAME, mapType(c), { nullable: c.IS_NULLABLE === 'YES' });
      });
      data.recordset.forEach(row => {
        table.rows.add(...cols.recordset.map(c => row[c.COLUMN_NAME]));
      });
      await local.request().bulk(table);
      copied += data.recordset.length;

      if (totalRows > CHUNK_SIZE) {
        process.stdout.write(`\r  ${TABLE_NAME}: ${copied}/${totalRows}`);
      }
    }
    console.log(`${totalRows > CHUNK_SIZE ? '\r' : ''}  ${TABLE_NAME}: ${copied} rows`);
  }

  console.log('\n복제 완료');
  await remote.close();
  await local.close();
})().catch(e => { console.error('실패:', e.message); process.exit(1); });

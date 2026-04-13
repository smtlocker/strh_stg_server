#!/usr/bin/env node
/**
 * Release 패키지 빌드.
 *
 * TypeScript 빌드 → production 의존성 설치 → Windows Portable Node.js 번들
 * → 배치 파일 생성 → release/ 폴더에 배포 가능한 패키지 생성.
 *
 * 사용법:
 *   npm run release
 *   node scripts/release.js
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const RELEASE = path.join(ROOT, 'release');
const CACHE = path.join(ROOT, '.cache');

const NODE_VERSION = '22.15.0';
const NODE_ARCHIVE = `node-v${NODE_VERSION}-win-x64`;
const NODE_ZIP = `${NODE_ARCHIVE}.zip`;
const NODE_URL = `https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ZIP}`;

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const follow = (url) => {
      https.get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          follow(res.headers.location);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${url}`));
          return;
        }
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
        file.on('error', reject);
      }).on('error', reject);
    };
    follow(url);
  });
}

async function ensureNode() {
  fs.mkdirSync(CACHE, { recursive: true });
  const zipPath = path.join(CACHE, NODE_ZIP);

  if (!fs.existsSync(zipPath)) {
    console.log(`       다운로드: ${NODE_URL}`);
    await download(NODE_URL, zipPath);
  } else {
    console.log('       캐시 사용');
  }

  const nodeDir = path.join(RELEASE, '.node');
  if (fs.existsSync(nodeDir)) fs.rmSync(nodeDir, { recursive: true });

  console.log('       압축 해제...');
  const tempDir = path.join(RELEASE, '.node-temp');
  execSync(`unzip -q "${zipPath}" -d "${tempDir}"`, { stdio: 'pipe' });
  fs.renameSync(path.join(tempDir, NODE_ARCHIVE), nodeDir);
  fs.rmSync(tempDir, { recursive: true });
}

function generateBatchFiles() {
  // macOS 에서 npm ci 하면 .bin/ 에 Unix symlink 가 생기므로 Windows 에서 동작 안 함.
  // node.exe 로 pm2 bin 을 직접 실행하는 방식으로 우회.
  const PM2 = '"%NODE_DIR%\\node.exe" "%ROOT_DIR%node_modules\\pm2\\bin\\pm2"';

  const startBat = `@echo off
chcp 65001 >nul
setlocal

set "ROOT_DIR=%~dp0"
set "NODE_DIR=%ROOT_DIR%.node"

if not exist "%NODE_DIR%\\node.exe" (
    echo ERROR: .node 폴더가 없습니다. release 패키지가 손상되었을 수 있습니다.
    pause
    exit /b 1
)

set "PATH=%NODE_DIR%;%PATH%"

echo SmartCube Sync Server 시작 중...
cd /d "%ROOT_DIR%"
${PM2} start ecosystem.config.js
echo.
${PM2} status
echo.
echo 서버가 시작되었습니다.
pause
`;

  const stopBat = `@echo off
chcp 65001 >nul
setlocal

set "ROOT_DIR=%~dp0"
set "NODE_DIR=%ROOT_DIR%.node"

if not exist "%NODE_DIR%\\node.exe" (
    echo ERROR: .node 폴더가 없습니다.
    pause
    exit /b 1
)

set "PATH=%NODE_DIR%;%PATH%"

echo SmartCube Sync Server 중지 중...
cd /d "%ROOT_DIR%"
${PM2} stop smartcube-sync
echo.
${PM2} status
echo.
echo 서버가 중지되었습니다.
pause
`;

  // migrate.bat 은 release 에 포함하지 않음 — 개발 PC 에서 npm run migrate 로 실행

  // Windows .bat 파일은 CRLF 필수
  const crlf = (s) => s.replace(/\r?\n/g, '\r\n');
  fs.writeFileSync(path.join(RELEASE, 'start-server.bat'), crlf(startBat));
  fs.writeFileSync(path.join(RELEASE, 'stop-server.bat'), crlf(stopBat));
  // migrate.bat 은 release 에 포함하지 않음 — 개발 PC 에서 npm run migrate 로 실행
}

async function main() {
  console.log('=== SmartCube Release Build ===');
  console.log('');

  // 1. Build
  console.log('[1/6] TypeScript 빌드...');
  execSync('npm run build', { cwd: ROOT, stdio: 'inherit' });

  // 2. Clean release dir
  console.log('[2/6] release/ 폴더 준비...');
  if (fs.existsSync(RELEASE)) fs.rmSync(RELEASE, { recursive: true });
  fs.mkdirSync(RELEASE, { recursive: true });

  // 3. Copy artifacts
  console.log('[3/6] 빌드 산출물 복사...');
  copyDir(path.join(ROOT, 'dist'), path.join(RELEASE, 'dist'));
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(RELEASE, 'package.json'));
  fs.copyFileSync(path.join(ROOT, 'package-lock.json'), path.join(RELEASE, 'package-lock.json'));
  fs.copyFileSync(path.join(ROOT, 'ecosystem.config.js'), path.join(RELEASE, 'ecosystem.config.js'));

  const envPath = path.join(ROOT, '.env');
  if (fs.existsSync(envPath)) {
    fs.copyFileSync(envPath, path.join(RELEASE, '.env'));
  }
  const envExPath = path.join(ROOT, '.env.example');
  if (fs.existsSync(envExPath)) {
    fs.copyFileSync(envExPath, path.join(RELEASE, '.env.example'));
  }

  // 4. Production dependencies
  // release 용 package.json 에서 dev 전용 scripts 제거 (lifecycle 충돌 방지)
  const relPkg = JSON.parse(fs.readFileSync(path.join(RELEASE, 'package.json'), 'utf8'));
  relPkg.scripts = { migrate: relPkg.scripts.migrate };
  fs.writeFileSync(path.join(RELEASE, 'package.json'), JSON.stringify(relPkg, null, 2) + '\n');

  console.log('[4/6] Production 의존성 설치...');
  execSync('npm ci --omit=dev', { cwd: RELEASE, stdio: 'inherit' });

  // 5. Windows Portable Node.js
  console.log('[5/6] Windows Portable Node.js v' + NODE_VERSION + '...');
  await ensureNode();

  // 6. Batch files
  console.log('[6/6] 배치 파일 생성...');
  generateBatchFiles();

  // Summary
  const size = execSync(`du -sh "${RELEASE}"`, { encoding: 'utf8' }).trim().split('\t')[0];
  console.log('');
  console.log('=== Release 빌드 완료 ===');
  console.log(`출력: release/`);
  console.log(`크기: ${size}`);
  console.log('');
  console.log('배포 방법:');
  console.log('  1. 개발 PC 에서 DB 마이그레이션: npm run migrate');
  console.log('  2. release/ 폴더를 대상 PC 에 복사');
  console.log('  3. .env 파일 확인 (DB/STG 접속 정보)');
  console.log('  4. start-server.bat 실행');
}

main().catch((err) => {
  console.error('FATAL:', err.message || err);
  process.exit(1);
});

@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

echo ============================================
echo   SmartCube Sync Server - Setup
echo ============================================
echo.

set "ROOT_DIR=%~dp0"
set "NODE_VERSION=22.15.0"
set "NODE_ARCHIVE=node-v%NODE_VERSION%-win-x64"
set "NODE_DIR=%ROOT_DIR%.node"

:: ── 1. Portable Node.js ──
if not exist "%NODE_DIR%\node.exe" (
    echo [1/5] Portable Node.js v%NODE_VERSION% 다운로드 중...

    powershell -Command "Invoke-WebRequest -Uri 'https://nodejs.org/dist/v%NODE_VERSION%/%NODE_ARCHIVE%.zip' -OutFile '%ROOT_DIR%node.zip'"

    if not exist "%ROOT_DIR%node.zip" (
        echo ERROR: Node.js 다운로드 실패. 네트워크 연결을 확인하세요.
        pause
        exit /b 1
    )

    echo        압축 해제 중...
    powershell -Command "Expand-Archive -Path '%ROOT_DIR%node.zip' -DestinationPath '%ROOT_DIR%.node-temp' -Force"

    if exist "%NODE_DIR%" rmdir /s /q "%NODE_DIR%"
    move "%ROOT_DIR%.node-temp\%NODE_ARCHIVE%" "%NODE_DIR%" >nul
    rmdir /s /q "%ROOT_DIR%.node-temp"
    del "%ROOT_DIR%node.zip"

    echo        Node.js v%NODE_VERSION% 설치 완료
) else (
    echo [1/5] Portable Node.js 이미 설치됨
)

set "PATH=%NODE_DIR%;%NODE_DIR%\node_modules\.bin;%PATH%"

:: ── 2. PM2 설치 ──
call pm2 --version >nul 2>&1
if errorlevel 1 (
    echo [2/5] PM2 설치 중...
    call npm install -g pm2
) else (
    echo [2/5] PM2 이미 설치됨
)

:: ── 3. Git Pull ──
echo [3/5] 최신 코드 가져오는 중...
cd /d "%ROOT_DIR%"
git pull https://github.com/smtlocker/strh_stg_server main
if errorlevel 1 (
    echo ERROR: git pull 실패
    pause
    exit /b 1
)

:: ── 4. 의존성 설치 및 빌드 ──
echo [4/5] 의존성 설치 및 빌드 중...
cd /d "%ROOT_DIR%"
call npm ci
if errorlevel 1 (
    echo ERROR: npm ci 실패
    pause
    exit /b 1
)
call npm run build
if errorlevel 1 (
    echo ERROR: 빌드 실패
    pause
    exit /b 1
)

:: ── 5. .env 파일 확인 ──
if not exist "%ROOT_DIR%.env" (
    echo [5/5] .env 파일이 없습니다. .env.example을 복사합니다...
    copy "%ROOT_DIR%.env.example" "%ROOT_DIR%.env" >nul
    echo        .env 파일을 열어 DB 접속 정보 등을 입력하세요.
) else (
    echo [5/5] .env 파일 확인 완료
)

echo.
echo ============================================
echo   Setup 완료!
echo.
echo   start-server.bat  - 서버 시작
echo   stop-server.bat   - 서버 중지
echo ============================================
pause

@echo off
chcp 65001 >nul
setlocal

cd /d "%~dp0"

echo ============================================
echo   SmartCube Release Build (Windows dev PC)
echo ============================================
echo.

:: 1. Git Pull (git repo 일 때만)
if exist .git (
    echo [1/3] git pull...
    git pull
    if errorlevel 1 (
        echo WARN: git pull 실패 — 로컬 상태로 계속 진행합니다.
    )
) else (
    echo [1/3] git repo 아님 — pull skip
)

:: 2. 의존성 설치 (devDependencies 포함 — nest build 에 필요)
echo.
echo [2/3] 의존성 설치...
call npm install
if errorlevel 1 (
    echo ERROR: npm install 실패
    pause
    exit /b 1
)

:: 3. Release 패키지 빌드
::    scripts/release.js 내부에서 release/ 가 이미 있으면 삭제 후 재생성합니다.
echo.
echo [3/3] release 패키지 빌드...
call npm run release
if errorlevel 1 (
    echo ERROR: release 빌드 실패
    pause
    exit /b 1
)

echo.
echo ============================================
echo   완료 — release 폴더 준비됨
echo   이 폴더를 그대로 대상 PC 에 복사하세요.
echo ============================================
pause

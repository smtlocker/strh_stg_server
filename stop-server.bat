@echo off
chcp 65001 >nul
setlocal

set "ROOT_DIR=%~dp0"
set "NODE_DIR=%ROOT_DIR%.node"

if not exist "%NODE_DIR%\node.exe" (
    echo ERROR: Node.js가 설치되지 않았습니다. setup.bat을 먼저 실행하세요.
    pause
    exit /b 1
)

set "PATH=%NODE_DIR%;%NODE_DIR%\node_modules\.bin;%PATH%"

echo SmartCube Sync Server 중지 중...
cd /d "%ROOT_DIR%"
call pm2 stop smartcube-sync
echo.
call pm2 status
echo.
echo 서버가 중지되었습니다.
pause

@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] node.exe not found. Please install Node.js or add it to PATH.
  pause
  exit /b 1
)
node codearts-login.mjs
set RC=%ERRORLEVEL%
echo.
pause
exit /b %RC%

@echo off
setlocal
cd /d "%~dp0tui-ink"
if not exist ".test-tmp" mkdir ".test-tmp"
set "TEMP=%~dp0tui-ink\.test-tmp"
set "TMP=%TEMP%"
if not defined SPAWN_CONFIG_DIR set "SPAWN_CONFIG_DIR=%~dp0tui-ink\.spawn\config"
call npm run build
if errorlevel 1 exit /b %errorlevel%
node dist\index.js %*
exit /b %errorlevel%

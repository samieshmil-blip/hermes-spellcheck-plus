@echo off
chcp 65001 >nul
setlocal enableextensions
set "NODE="
where node >nul 2>nul && set "NODE=node"
if not defined NODE for /d %%D in ("%LOCALAPPDATA%\hermes\tools\node-*") do if exist "%%~fD\node.exe" set "NODE=%%~fD\node.exe"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE (echo [ru-spellcheck] node.exe ne nayden & exit /b 2)
"%NODE%" "%~dp0apply-fix.cjs"
if errorlevel 1 (echo [ru-spellcheck] PRAVKA NE PRIMENENA - sm. apply-fix.log) else (echo [ru-spellcheck] Gotovo.)
if /i not "%1"=="--quiet" pause
endlocal

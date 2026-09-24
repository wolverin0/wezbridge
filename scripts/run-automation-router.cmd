@echo off
REM T-0598 Fase B-1: durable entry point for the automation-router schtask
REM (Windows Task Scheduler, every 15 min). Mirrors run-fleet-steward.cmd's
REM pattern: chcp 65001 for UTF-8 redirected output, append-only log next to
REM the findings dir the router itself uses (_intel/automation-findings/).
setlocal
chcp 65001 >nul
set REPO=%~dp0..
set FINDINGS=%REPO%\..\_intel\automation-findings
node "%REPO%\scripts\automation-router.cjs" > "%FINDINGS%\router-run-latest.txt" 2>&1
set RESULT=%ERRORLEVEL%
echo [%DATE% %TIME%] exit=%RESULT% >> "%FINDINGS%\router-run.log"
type "%FINDINGS%\router-run-latest.txt" >> "%FINDINGS%\router-run.log"
exit /b %RESULT%

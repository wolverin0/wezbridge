@echo off
REM Durable entry point for the fleet steward (Windows Task Scheduler).
REM Session-bound schedulers (/loop, ScheduleWakeup, CronCreate) die with the
REM pane that armed them; this survives reboots and having no agent running.
setlocal
REM Task Scheduler starts cmd in the OEM codepage, which mangles non-ASCII in
REM the redirected report. Force UTF-8 so the log stays readable.
chcp 65001 >nul
set REPO=%~dp0..
set INTEL=%REPO%\..\_intel
node "%REPO%\scripts\fleet-steward.cjs" > "%INTEL%\steward-latest.txt" 2>&1
set RESULT=%ERRORLEVEL%
echo [%DATE% %TIME%] exit=%RESULT% >> "%INTEL%\steward.log"
type "%INTEL%\steward-latest.txt" >> "%INTEL%\steward.log"
exit /b %RESULT%

@echo off
REM ---------------------------------------------------------------------------
REM poke-pane.cmd - Task Scheduler entry point. No Claude, no MCP, no API call.
REM
REM ASCII ONLY IN THIS FILE. Multi-byte characters (em-dashes) in these comments
REM were harmless under the default OEM codepage but desynced cmd's parser once
REM a CALLER ran `chcp 65001` first - cmd then executed fragments of these very
REM comments ("'M' is not recognized"). Found 2026-08-13 when run-steward-gate
REM called this script. Delivery still worked, which is worse: a scheduled job
REM spraying spurious errors is how a real failure gets ignored.
REM
REM   schtasks /create /tn "Poke brlite nightly" /sc daily /st 04:30 ^
REM     /tr "\"G:\_OneDrive\OneDrive\Desktop\Py Apps\wezbridge\scripts\poke-pane.cmd\" brlite \"G:\path\to\message.txt\""
REM
REM Arg 1 = project name (cwd basename of the target pane, resolved at fire time)
REM Arg 2 = path to a file holding the message text
REM
REM Every run appends one line to poke-pane.log - success or failure. A silent
REM scheduled job is indistinguishable from one that had nothing to do.
REM ---------------------------------------------------------------------------
setlocal
set "DIR=%~dp0"
set "LOG=%DIR%poke-pane.log"

if "%~1"=="" ( echo %DATE% %TIME% poke-pane.cmd FAIL: missing project arg >> "%LOG%" & exit /b 2 )
if "%~2"=="" ( echo %DATE% %TIME% poke-pane.cmd FAIL: missing message-file arg >> "%LOG%" & exit /b 2 )
if not exist "%~2" ( echo %DATE% %TIME% poke-pane.cmd FAIL: message file not found: %~2 >> "%LOG%" & exit /b 2 )

node "%DIR%poke-pane.cjs" --project "%~1" --file "%~2" >> "%LOG%" 2>&1
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" echo %DATE% %TIME% poke-pane.cmd exit=%RC% >> "%LOG%"
exit /b %RC%

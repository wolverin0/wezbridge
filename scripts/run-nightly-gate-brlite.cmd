@echo off
REM ---------------------------------------------------------------------------
REM run-nightly-gate-brlite.cmd - the first scheduled ROUTINE. No model in it.
REM
REM WHY THIS SHAPE. The operator asked whether the orchestrator should auto-poke
REM itself on a schedule and drive the panes. No. A clock-triggered "wake up and
REM see if anything needs doing" poke is precisely the orchestrator-waker, which
REM accumulated 55 undrained intents before being disarmed on 2026-08-13. The
REM rule that survived: SCHEDULED POKES WORK WHEN THEY CARRY A SELF-CONTAINED
REM TASK WITH MACHINE-CHECKABLE ACCEPTANCE, and fail when they carry "check if
REM there is anything to do".
REM
REM So the first routine wakes NOBODY. It runs brlite's own gate and writes an
REM evidence file. A model is involved only if that evidence shows a problem --
REM condition-triggered, not clock-triggered.
REM
REM Ownership: wezbridge owns the SCHEDULING, brlite owns its GATE. This script
REM invokes check.sh and writes a result; it never edits brlite source.
REM
REM 03:00 deliberately: check.sh takes ~40 minutes, needs a quiet machine, and
REM the operator plays the game in the evening. A run under contention is void
REM (proven 2026-08-13 - his launcher taskkills Godot and killed the fixtures).
REM
REM ASCII ONLY. Multi-byte chars in batch comments desync cmd's parser once a
REM caller sets a codepage.
REM ---------------------------------------------------------------------------
setlocal
chcp 65001 >nul
set "BRLITE=G:\_OneDrive\OneDrive\Desktop\Py Apps\brlite"
set "OUT=%BRLITE%\.orchestrator\results"
set "LOG=%~dp0..\logs\nightly-gate-brlite.log"
if not exist "%~dp0..\logs" mkdir "%~dp0..\logs"
if not exist "%OUT%" mkdir "%OUT%"

for /f "tokens=1-3 delims=/ " %%a in ("%DATE%") do set "STAMP=%%c%%b%%a"
set "RESULT=%OUT%\nightly-gate-%STAMP%.json"

echo [%DATE% %TIME%] nightly gate START >> "%LOG%"

pushd "%BRLITE%"
bash tools/check.sh > "%OUT%\nightly-gate-%STAMP%.log" 2>&1
set "RC=%ERRORLEVEL%"
popd

REM The result file IS the deliverable. exit_status is the verdict; nothing else
REM is. A missing file means the routine did not run, which is a different fact
REM from a red gate and must never be confused with one.
> "%RESULT%" echo {
>> "%RESULT%" echo   "routine": "nightly-gate-brlite",
>> "%RESULT%" echo   "date": "%DATE%",
>> "%RESULT%" echo   "time": "%TIME%",
>> "%RESULT%" echo   "command": "bash tools/check.sh",
>> "%RESULT%" echo   "exit_status": %RC%,
>> "%RESULT%" echo   "verdict": "%RC%",
>> "%RESULT%" echo   "log": "nightly-gate-%STAMP%.log",
>> "%RESULT%" echo   "note": "verdict is read from exit_status only, never from log text"
>> "%RESULT%" echo }

echo [%DATE% %TIME%] nightly gate END exit=%RC% result=%RESULT% >> "%LOG%"
endlocal & exit /b %RC%

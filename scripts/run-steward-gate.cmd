@echo off
REM ---------------------------------------------------------------------------
REM run-steward-gate.cmd - durable entry point for the steward GATE.
REM
REM The steward (run-fleet-steward.cmd, 09:00) finds forgotten work and writes a
REM REPORT. A report can be read and narrated past, which is exactly what
REM happened: it was correct from 2026-07-29 and nothing consumed it for 15 days
REM while 26 ready tasks sat idle. This runs five minutes later and turns that
REM report into a CHECK THAT CAN FAIL.
REM
REM There is no model in this path. Task Scheduler is the only thing on this
REM machine that is genuinely 24/7 (WezTerm is not, and neither is any agent).
REM
REM Exit codes from steward-gate.cjs:
REM   0  GREEN    every past-deadline finding carries a ruling -> log only
REM   1  RED      something is past deadline with NO ruling    -> poke
REM   3  UNKNOWN  could not obtain findings                    -> poke
REM
REM UNKNOWN POKES TOO, DELIBERATELY. A scan that did not happen is not a clean
REM scan. Treating "I could not see" as "nothing to see" is the single defect
REM this repo has fixed in five other places; it does not get to reappear here.
REM
REM The poke is a COURTESY, not the forcing function. The forcing function is
REM that RED re-fires every single day and is cleared ONLY by appending a ruling
REM to _intel/rulings.jsonl. If we ever start depending on the pane reacting to
REM the poke, we have rebuilt the orchestrator-waker and should stop.
REM
REM ASCII ONLY IN THIS FILE. Multi-byte characters desync cmd's batch parser and
REM it starts executing fragments of its own comments ("'M' is not recognized").
REM Observed here on 2026-08-13 with em-dashes in these very comments.
REM ---------------------------------------------------------------------------
setlocal
REM Task Scheduler starts cmd in the OEM codepage, which mangles non-ASCII in
REM the redirected report. Force UTF-8 so the log stays readable.
chcp 65001 >nul
set "REPO=%~dp0.."
set "INTEL=%REPO%\..\_intel"
set "LATEST=%INTEL%\steward-gate-latest.txt"
set "MSG=%INTEL%\steward-gate-poke.txt"

node "%REPO%\scripts\steward-gate.cjs" > "%LATEST%" 2>&1
set "RESULT=%ERRORLEVEL%"

REM One log line on EVERY path. A scheduled job that logs nothing is
REM indistinguishable from one that never ran.
echo [%DATE% %TIME%] exit=%RESULT% >> "%INTEL%\steward-gate.log"
type "%LATEST%" >> "%INTEL%\steward-gate.log"

if "%RESULT%"=="0" goto :done

REM Send a SHORT POINTER, never the finding list. Long payloads get truncated by
REM TUIs, and dumping 30 findings into a composer buries the one line that says
REM what to do. The full list is already on disk at %LATEST%.
if "%RESULT%"=="1" set "HEAD=[steward-gate RED] Work is past deadline with no ruling. Read _intel\steward-gate-latest.txt, then rule or dispatch each item. Narrating does not clear this - it re-fires tomorrow."
if "%RESULT%"=="3" set "HEAD=[steward-gate UNKNOWN] The gate could NOT read its findings. This is a blind board, not a clean one. See _intel\steward-gate-latest.txt, fix the scan, re-run."
if not defined HEAD set "HEAD=[steward-gate exit=%RESULT%] Unexpected exit code. See _intel\steward-gate-latest.txt."

> "%MSG%" echo %HEAD%

REM Resolve the target by project at fire time. Pane ids get reused; a stored id
REM once poked a completely unrelated project.
call "%REPO%\scripts\poke-pane.cmd" wezbridge "%MSG%"

:done
endlocal & exit /b %RESULT%

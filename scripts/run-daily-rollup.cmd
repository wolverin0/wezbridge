@echo off
REM ---------------------------------------------------------------------------
REM run-daily-rollup.cmd - durable entry point for the operator's daily rollup.
REM
REM Thin on purpose (same rule as run-orchestrator-turn.cmd): every decision
REM lives in daily-rollup.cjs. Batch is where this repo has lost the most time
REM to silent parse failures, so the scheduler entry point stays the least
REM clever file in the chain.
REM
REM Scheduled daily at 02:30 (NOT 02:00 - NAS-Sync-PyApps runs then) as
REM wezbridge-daily-rollup. At that hour the rollup closes YESTERDAY, which is
REM the day the operator reads about over breakfast. Output lands in
REM _intel\rollups\YYYY-MM-DD.md; the run itself logs one daily_rollup line to
REM actions.jsonl so the rollup shows up in its own next census.
REM
REM Exit codes: 0 rollup written, 1 the rollup itself broke. There is no
REM "alert" exit here - the rollup REPORTS alerts (silent-failure census
REM class), it is not one.
REM
REM ASCII ONLY. Multi-byte characters desync cmd's parser once a caller sets a
REM codepage, and it starts executing fragments of its own comments.
REM ---------------------------------------------------------------------------
setlocal
chcp 65001 >nul
set "REPO=%~dp0.."
set "INTEL=%REPO%\..\_intel"

node "%REPO%\scripts\daily-rollup.cjs" >> "%INTEL%\daily-rollup.log" 2>&1
set "RESULT=%ERRORLEVEL%"

REM One line on every path. A scheduled job that logs nothing is
REM indistinguishable from one that never ran.
echo [%DATE% %TIME%] daily-rollup exit=%RESULT% >> "%INTEL%\daily-rollup.log"
endlocal & exit /b %RESULT%

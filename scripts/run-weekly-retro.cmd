@echo off
REM ---------------------------------------------------------------------------
REM run-weekly-retro.cmd - durable entry point for the weekly RL retro.
REM
REM Thin on purpose (same rule as run-daily-rollup.cmd / run-orchestrator-turn.cmd):
REM every decision lives in weekly-retro.cjs. Batch stays the least clever file
REM in the chain.
REM
REM Scheduled MONDAYS at 08:15 as wezbridge-weekly-retro. Output lands in
REM _intel\rollups\retro-YYYY-Www.md (+ wezbridge\artifacts\rollup-retro-*.html);
REM the run itself logs one weekly_retro line to actions.jsonl.
REM
REM Exit codes: 0 retro written, 1 the retro itself broke.
REM
REM ASCII ONLY. Multi-byte characters desync cmd's parser once a caller sets a
REM codepage, and it starts executing fragments of its own comments.
REM ---------------------------------------------------------------------------
setlocal
chcp 65001 >nul
set "REPO=%~dp0.."
set "INTEL=%REPO%\..\_intel"

node "%REPO%\scripts\weekly-retro.cjs" >> "%INTEL%\weekly-retro.log" 2>&1
set "RESULT=%ERRORLEVEL%"

REM One line on every path. A scheduled job that logs nothing is
REM indistinguishable from one that never ran.
echo [%DATE% %TIME%] weekly-retro exit=%RESULT% >> "%INTEL%\weekly-retro.log"
endlocal & exit /b %RESULT%

@echo off
REM ---------------------------------------------------------------------------
REM run-orchestrator-turn.cmd - durable entry point for the decide/dispatch loop.
REM
REM Thin on purpose. Every decision lives in orchestrator-turn.cjs, because batch
REM is where this repo has lost the most time to silent parse failures, and a
REM scheduler entry point must be the least clever file in the chain.
REM
REM WHAT CHANGED, AND WHY THIS IS NOT THE 2026-04 WAKER AGAIN. That one fired a
REM clock and asked a pane "is there anything to do?", accumulating 55 undrained
REM intents while looking healthy. This one evaluates a DETERMINISTIC trigger
REM first, for free, and wakes nothing unless the gate is non-green or finished
REM work is sitting unjudged. When it does wake something it carries the specific
REM reason. And it counts its own results: three consecutive turns that change no
REM file raise T-LOOP-STALL to the operator instead of poking forever.
REM
REM Exit codes: 0 the turn completed normally (nothing to do, poked, or headless)
REM             4 the turn itself broke
REM             30 the loop is stalled - non-zero on purpose, that IS the alert
REM
REM ASCII ONLY. Multi-byte characters desync cmd's parser once a caller sets a
REM codepage, and it starts executing fragments of its own comments.
REM ---------------------------------------------------------------------------
setlocal
chcp 65001 >nul
set "REPO=%~dp0.."
set "INTEL=%REPO%\..\_intel"

node "%REPO%\scripts\orchestrator-turn.cjs" >> "%INTEL%\orchestrator-turn.log" 2>&1
set "RESULT=%ERRORLEVEL%"

REM One line on every path. A scheduled job that logs nothing is
REM indistinguishable from one that never ran.
echo [%DATE% %TIME%] orchestrator-turn exit=%RESULT% >> "%INTEL%\orchestrator-turn.log"
endlocal & exit /b %RESULT%

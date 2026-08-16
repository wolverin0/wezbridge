@echo off
REM ---------------------------------------------------------------------------
REM run-routine.cmd - run a maintenance ROUTINE in a FRESH HEADLESS SESSION
REM                   inside a DISPOSABLE GIT WORKTREE.
REM
REM   run-routine.cmd <routine-name> <project-dir> [cadence-hours]
REM   run-routine.cmd test-strength-audit "G:\...\Py Apps\wezbridge" 168
REM
REM WHY A FRESH SESSION AND NOT A PANE POKE. The operator asked whether the
REM orchestrator should auto-poke itself to run routines. No -- but the reason
REM is not the one I first gave. A clock-triggered poke carrying "check if
REM anything needs doing" is the orchestrator-waker and it failed. A poke
REM carrying "run THIS routine, produce THIS artifact" is self-contained and
REM verifiable, which is legitimate. The problem with pointing it at a long-
REM lived pane is CONTEXT: pane-0 reached ~90% of its window in a single day of
REM coordinating. Routine work would consume the decider's budget doing grunt
REM work, which is exactly backwards.
REM
REM WHY A WORKTREE (added 2026-08-14, before the first unattended run). The
REM test-strength routine's whole method is to BREAK code on purpose and put it
REM back. Doing that in the operator's live tree means a routine that dies
REM mid-mutation -- crash, timeout, context exhaustion, machine sleep -- leaves
REM broken source behind, on top of whatever uncommitted work was already there.
REM "Restore it afterwards" is a promise made by the same process that just
REM proved it can stop early.
REM
REM A detached worktree at HEAD removes the promise. The routine gets a real
REM checkout to mutate; the operator's tree is not reachable by cwd; the whole
REM thing is deleted afterwards whether the routine behaved or not. Note what
REM this does and does not buy: it prevents ACCIDENTS, which is the failure mode
REM that actually happens. It is not a sandbox. The routine runs with
REM --dangerously-skip-permissions and could write anywhere it can name.
REM
REM Testing HEAD rather than the working tree is a feature, not a compromise:
REM a scheduled audit should judge committed code, not whatever was half-typed
REM when the clock struck.
REM
REM WHAT THE RUNNER GUARANTEES AND WHAT IT REFUSES TO GUESS. It writes a run
REM record for EVERY run including failures. It never decides whether the code
REM is good -- only whether the routine RAN. Those are different facts and
REM conflating them is the defect this repo keeps re-finding. If the routine
REM produced no findings artifact, that is recorded as an absence, and
REM routine-audit.cjs turns it into a finding rather than silence.
REM
REM ASCII ONLY: multi-byte chars in batch comments desync cmd's parser.
REM
REM Exit codes: 0 ran   2 bad args   3 no prompt   4 no project dir
REM             5 project not versioned   6 could not isolate   7 no artifact
REM             other = the routine's own exit code
REM ---------------------------------------------------------------------------
setlocal
chcp 65001 >nul

set "NAME=%~1"
set "PROJ=%~2"
set "CADENCE=%~3"
if "%CADENCE%"=="" set "CADENCE=168"

for %%i in ("%~dp0..") do set "REPO=%%~fi"
for %%i in ("%REPO%\..\_intel") do set "INTEL=%%~fi"
set "PROMPT=%REPO%\routines\%NAME%.md"
set "LOG=%REPO%\logs\routine-%NAME%.log"
set "FIND=%INTEL%\routine-findings"
if not exist "%REPO%\logs" mkdir "%REPO%\logs"
if not exist "%FIND%" mkdir "%FIND%"

if "%NAME%"=="" ( echo %DATE% %TIME% FAIL: missing routine name >> "%LOG%" & exit /b 2 )
if "%PROJ%"=="" ( echo %DATE% %TIME% FAIL: missing project dir >> "%LOG%" & exit /b 2 )
if not exist "%PROMPT%" ( echo %DATE% %TIME% FAIL: no prompt at %PROMPT% >> "%LOG%" & exit /b 3 )
if not exist "%PROJ%" ( echo %DATE% %TIME% FAIL: no project dir %PROJ% >> "%LOG%" & exit /b 4 )

REM Refuse to run against an unversioned tree. Now doubly binding: without git
REM there is no worktree to isolate into, so the routine would have to mutate
REM the live directory with no undo. This fleet has three such projects.
if not exist "%PROJ%\.git" (
  echo %DATE% %TIME% REFUSED: %PROJ% has no .git - routines must not run on an unversioned tree >> "%LOG%"
  exit /b 5
)

for %%i in ("%PROJ%") do set "REPONAME=%%~nxi"
for /f %%i in ('powershell -NoProfile -Command Get-Date -Format yyyyMMdd-HHmmss') do set "STAMP=%%i"
for /f %%i in ('powershell -NoProfile -Command Get-Date -Format o') do set "ISO=%%i"

set "WT=%TEMP%\wezbridge-routine\%NAME%-%REPONAME%-%STAMP%"
set "OUTFILE=%FIND%\%NAME%-%REPONAME%-%STAMP%.json"
set "RECORD=%FIND%\run-%NAME%-%REPONAME%-%STAMP%.json"

echo [%DATE% %TIME%] routine %NAME% START repo=%REPONAME% worktree=%WT% >> "%LOG%"

REM Clear any worktree a previous run died holding, then isolate. If isolation
REM fails we STOP. Falling back to the live tree would silently trade the whole
REM safety property for one more data point, which is never the right trade.
git -C "%PROJ%" worktree prune >> "%LOG%" 2>&1
git -C "%PROJ%" worktree add --detach "%WT%" HEAD >> "%LOG%" 2>&1
if errorlevel 1 (
  echo [%DATE% %TIME%] routine %NAME% ABORT: could not create worktree - NOT falling back to the live tree >> "%LOG%"
  call :record 6
  exit /b 6
)

REM The routine reads these instead of hardcoding paths. ROUTINE_OUT is absolute
REM on purpose: a relative path would resolve inside the worktree and be deleted
REM with it, which is how a routine loses the only thing it was asked to produce.
set "ROUTINE_OUT=%OUTFILE%"
set "ROUTINE_NAME=%NAME%"
set "ROUTINE_REPO=%REPONAME%"
set "ROUTINE_REPO_DIR=%PROJ%"

pushd "%WT%"
type "%PROMPT%" | claude -p --dangerously-skip-permissions >> "%LOG%" 2>&1
set "RC=%ERRORLEVEL%"
popd

REM Teardown is unconditional and its failure must not be mistaken for the
REM routine's own result. A leftover worktree is cleaned by the prune above on
REM the next run; a wrong exit code would be believed forever.
git -C "%PROJ%" worktree remove --force "%WT%" >> "%LOG%" 2>&1
if errorlevel 1 echo [%DATE% %TIME%] WARN: worktree teardown failed, next run will prune it >> "%LOG%"

call :record %RC%

if not exist "%OUTFILE%" (
  echo [%DATE% %TIME%] routine %NAME% END exit=%RC% but NO ARTIFACT at %OUTFILE% >> "%LOG%"
  endlocal & exit /b 7
)

echo [%DATE% %TIME%] routine %NAME% END exit=%RC% artifact=%OUTFILE% >> "%LOG%"
endlocal & exit /b %RC%

REM ---------------------------------------------------------------------------
REM :record <exit-status> - the run record. Written on EVERY path, including the
REM abort path, because "no record" and "clean run" must never look the same to
REM the consumer. Backslashes become forward slashes: a Windows path inside a
REM JSON string is an invalid escape sequence and would make the record
REM unparseable, which would turn this evidence file into silence.
REM ---------------------------------------------------------------------------
:record
set "OUTJSON=%OUTFILE:\=/%"
> "%RECORD%" echo {
>> "%RECORD%" echo   "routine": "%NAME%",
>> "%RECORD%" echo   "repo": "%REPONAME%",
>> "%RECORD%" echo   "ended": "%ISO%",
>> "%RECORD%" echo   "exit_status": %~1,
>> "%RECORD%" echo   "cadence_hours": %CADENCE%,
>> "%RECORD%" echo   "findings_file": "%OUTJSON%",
>> "%RECORD%" echo   "isolated": "git worktree, detached at HEAD, removed after the run",
>> "%RECORD%" echo   "note": "this record says whether the ROUTINE ran. The verdict about the CODE lives only in findings_file."
>> "%RECORD%" echo }
goto :eof

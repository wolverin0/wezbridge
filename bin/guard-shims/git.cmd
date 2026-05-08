@echo off
REM guard-shims/git.cmd — destructive-op gate around git for cmd.exe / PowerShell.
REM Mirror of git.sh. See that file + docs/PLAN-managed-agents-backfill.md task #1.

setlocal EnableDelayedExpansion

set "SCRIPT_DIR=%~dp0"
set "GUARD_JS=%SCRIPT_DIR%..\..\scripts\command-guard.cjs"

if not exist "%GUARD_JS%" (
  echo guard-shim: command-guard.cjs not found at %GUARD_JS% 1>&2
  exit /b 127
)

REM 1. Evaluate. Guard exits 0 (allow) or 1 (block, with stderr message).
call node "%GUARD_JS%" git %*
if !errorlevel! neq 0 exit /b 1

REM 2. Find real git, skipping our own shim dir. `where git` lists every
REM    matching executable in PATH; pick the first whose dir != SCRIPT_DIR.
set "REAL_GIT="
for /f "delims=" %%G in ('where git 2^>nul') do (
  if not defined REAL_GIT (
    set "CAND=%%G"
    set "CAND_DIR=%%~dpG"
    if /i not "!CAND_DIR!"=="%SCRIPT_DIR%" set "REAL_GIT=!CAND!"
  )
)

if not defined REAL_GIT (
  echo guard-shim: real git not found in PATH ^(excluding %SCRIPT_DIR%^) 1>&2
  exit /b 127
)

REM 3. Pass through. Use call so errorlevel propagates correctly to caller.
call "%REAL_GIT%" %*
exit /b !errorlevel!

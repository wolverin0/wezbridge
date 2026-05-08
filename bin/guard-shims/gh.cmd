@echo off
REM guard-shims/gh.cmd — destructive-op gate around gh (GitHub CLI) for cmd.exe.
REM Mirror of gh.sh. See git.cmd for full notes.

setlocal EnableDelayedExpansion

set "SCRIPT_DIR=%~dp0"
set "GUARD_JS=%SCRIPT_DIR%..\..\scripts\command-guard.cjs"

if not exist "%GUARD_JS%" (
  echo guard-shim: command-guard.cjs not found at %GUARD_JS% 1>&2
  exit /b 127
)

call node "%GUARD_JS%" gh %*
if !errorlevel! neq 0 exit /b 1

set "REAL_GH="
for /f "delims=" %%G in ('where gh 2^>nul') do (
  if not defined REAL_GH (
    set "CAND=%%G"
    set "CAND_DIR=%%~dpG"
    if /i not "!CAND_DIR!"=="%SCRIPT_DIR%" set "REAL_GH=!CAND!"
  )
)

if not defined REAL_GH (
  echo guard-shim: real gh not found in PATH ^(excluding %SCRIPT_DIR%^) 1>&2
  exit /b 127
)

call "%REAL_GH%" %*
exit /b !errorlevel!

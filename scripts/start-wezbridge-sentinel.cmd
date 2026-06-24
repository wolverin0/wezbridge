@echo off
setlocal

set "ROOT=%~dp0.."
set "PERSONA=%USERPROFILE%\.claude\agents\wezbridge-sentinel.md"

mkdir "%USERPROFILE%\.claude\agents" 2>nul
copy /Y "%ROOT%\docs\personas\wezbridge-sentinel.md" "%PERSONA%" >nul

cd /d "%ROOT%"
claude --continue --append-system-prompt-file "%PERSONA%" --dangerously-skip-permissions

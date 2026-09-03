@echo off
REM start-telegram-streamer.cmd
REM Launches the Telegram streamer (src/telegram-streamer.cjs) as a detached
REM background Node.js process. Idempotent — if a streamer is already running
REM this script does nothing. Designed to be registered as a Windows Scheduled
REM Task at user logon so the feed survives wezterm crashes and reboots.
REM
REM Logs land at %WEZBRIDGE_DIR%\logs\streamer.log (appended).

setlocal
set "WEZBRIDGE_DIR=G:\_OneDrive\OneDrive\Desktop\Py Apps\wezbridge"
set "STREAMER=%WEZBRIDGE_DIR%\src\telegram-streamer.cjs"
set "LOGDIR=%WEZBRIDGE_DIR%\logs"
set "LOG=%LOGDIR%\streamer.log"

if not exist "%LOGDIR%" mkdir "%LOGDIR%"

REM Idempotency check: is a streamer already running?
for /f "tokens=*" %%p in ('wmic process where "Name='node.exe' and CommandLine like '%%telegram-streamer.cjs%%'" get ProcessId /format:value 2^>nul ^| findstr /r "[0-9]"') do (
    echo %DATE% %TIME% [start-telegram-streamer] already running: %%p >> "%LOG%"
    exit /b 0
)

REM 2026-09-02 (decision del operador): el chat del plugin de Telegram (~/.claude/channels/telegram/.env)
REM daba "chat not found" desde el 13-ago. El canal que SI le llega al operador es el bot de wabot
REM (DM al OWNER). Se leen token y owner de su .env EN EL MOMENTO DE ARRANCAR, sin copiarlos a otro
REM archivo; el streamer prioriza estas variables de entorno sobre el .env del plugin.
set "WABOT_ENV=G:\_OneDrive\OneDrive\Desktop\Py Apps\whatsappbot-prod - Copy - Copy\whatsappbot-final\.env"
if exist "%WABOT_ENV%" (
    for /f "usebackq tokens=1,* delims==" %%a in ("%WABOT_ENV%") do (
        if /i "%%a"=="TELEGRAM_BOT_TOKEN" set "TELEGRAM_BOT_TOKEN=%%b"
        if /i "%%a"=="TELEGRAM_OWNER_ID" set "TELEGRAM_GROUP_ID=%%b"
    )
)
if not defined TELEGRAM_GROUP_ID echo %DATE% %TIME% [start-telegram-streamer] WARN: sin TELEGRAM_OWNER_ID en el .env de wabot, cae al .env del plugin >> "%LOG%"
REM En un DM no hay topics por proyecto: el modo raw (stream de cada pane) es un solo chat
REM interleavado, y events le mandaba al operador "Write <ruta>" por cada archivo escrito (2026-09-03).
REM decisions = SOLO el push de decisiones; ningun evento de pane sale por Telegram. Override con STREAMER_MODE.
if not defined STREAMER_MODE set "STREAMER_MODE=decisions"
REM Lo que el operador pidio de este canal son las DECISIONES (decision-push cada 60 s). El stream de
REM eventos de panes en un DM es ruido: se sondea cada 10 min en vez de cada 10 s. Override con STREAMER_POLL_MS.
if not defined STREAMER_POLL_MS set "STREAMER_POLL_MS=600000"
echo %DATE% %TIME% [start-telegram-streamer] launching node "%STREAMER%" >> "%LOG%"

REM `start /B` detaches. `"" ""` are the (empty) window title arg and program.
REM We use `node` from PATH which should be fine at logon time.
start /B "" node "%STREAMER%" >> "%LOG%" 2>&1

exit /b 0

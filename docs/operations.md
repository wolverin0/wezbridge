<!-- doc-head: Runtime operation, recovery and removal of pane-count limiting -->
Read for environment settings, MCP reload boundaries, mux identity and GUI recovery.
Pane-count limiting was removed by operator decision 2026-09-10; legacy env limits are ignored.
Source edits do not update already-loaded MCP processes.
<!-- /doc-head -->

# Operations — env vars, restart, crash recovery, mux-wedge + GUI-hang triage (wezbridge)
> Qué cubre: variables de entorno útiles, el gotcha de rebind del daemon :4200, latitud WSL,
> recuperación de crash de wezterm, el triage mux-lento-vs-mux-wedgeado (firmas idénticas,
> remedios opuestos), el tercer caso GUI colgado con mux sano (2026-09-01), y el broadcast de
> `/mcp reconnect <server>` a todos los panes Orca Claude idle (T-0569) para cuando un MCP
> (p.ej. MemoryMaster) queda "disconnected" en varios panes a la vez.
> Leer cuando: el daemon no rebindea, wezterm crasheó, todo ETIMEDOUTea, un GUI dice "not
> responding", hay >1 wezterm-mux-server, un MCP aparece desconectado en varios panes, vas
> a setear env de guards/grader/inbox, o estás tocando qué despierta al Fleet (digest/waker).
> Términos clave: WEZBRIDGE_*, restore-session, probeMux, degraded, inconclusive,
> session-snapshot, --no-auto-start, gui-watchdog, Recover-WezTermGui, mux_split,
> espacio único de pane_id (--prefer-mux + sock, T-0260), WEZBRIDGE_PREFER_MUX=0, gui_only,
> dead-man switch (VM omni-deadman.sh + DaemonSentinel touch, T-0529), deadman-touch.json,
> mcp-reconnect-broadcast.cjs, skip:self-busy, ORCA_TERMINAL_HANDLE, fleet-digest, classifyEvent,
> --count-day, orchestrator-waker (legado, desarmado).

## Espacio único de pane_id: el mux (T-0260, 2026-09-02)

Un `pane_id` solo significa algo dentro de UN socket. Esta máquina corre un `wezterm-mux-server`
(`~/.local/share/wezterm/sock`, estable por días) y una GUI que se reemplaza seguido (`gui-sock-<pid>`,
17+ veces el 2026-09-02 por el watchdog), y **las dos numeran los mismos panes distinto** (medido: la
misma pane era 11 en `sock` y 4 en la GUI). Resolver un id contra "la GUI viva del minuto" produjo
4 misroutes reales en un día. Regla vigente, implementada en `src/wezterm.cjs` y `scripts/poke-pane.cjs`:

- **Todo `wezterm cli` lleva `--prefer-mux` Y el env fija `WEZTERM_UNIX_SOCKET` al `sock` del mux**
  (`CLI_BASE` + `muxEnv()`). Las dos cosas: medido que `--prefer-mux` solo no alcanza si el env apunta
  a un gui-sock. `WEZTERM_PANE` se borra del env (es un id del otro espacio).
- `discover_sessions` publica **una fila por pane real con el id del mux**; la GUI aparece solo en
  `also_on`. Una pane que exista únicamente en una GUI (spawneada fuera del dominio) se conserva con
  `gui_only: true`: su id NO es del espacio canónico.
- `poke-pane --tab-title` compara **exacto** (case-insensitive); más de un match es exit 5, nunca "el
  primero". Prefiere el mux; cae a la GUI solo para panes gui-only, y lo imprime.
- Guard: `test/mux-single-id-space.test.cjs` falla si aparece un array `cli` sin `--prefer-mux` en
  `src/` o `scripts/`. Escape hatch de diagnóstico: `WEZBRIDGE_PREFER_MUX=0` (hablar con la GUI).
- Gotcha Windows: `sock` es un AF_UNIX socket y `fs.existsSync` dice que no existe; se detecta con
  `readdirSync`. El MCP de cada pane carga `src/*` al arrancar: hasta reiniciar la sesión, ese pane
  sigue resolviendo con la regla vieja.

## Variables de entorno útiles
- `WEZTERM_LOG=wezterm_mux_server_impl::local=off` — silencia la categoría de error 10054
  (mux-disconnect) de WezTerm en Windows
- `DASHBOARD_PORT` — override del `:4200`
- `WEZBRIDGE_GUARD_SHIMS=1` — activa el guard de comandos por PATH (requiere `bin/guard-shims/` en PATH)
- `WEZBRIDGE_GUARD_OVERRIDE`, `WEZBRIDGE_SAFETY_OVERRIDE`, `WEZBRIDGE_PREPUSH_OVERRIDE` —
  bypass-de-una-vez para los guards v3.2
- `WEZBRIDGE_MM_INBOX=1` — habilita escrituras del memory-inbox
- `WEZBRIDGE_GRADER_BACKEND=stub|claude|codex` — backend del outcome-grader
- `WEZBRIDGE_MAX_PANES` — retirado (decision del operador 2026-09-10): no limita panes.
  Se ignoran tambien valores heredados como `20`; el tope no vuelve al recargar un MCP.
  Los MCP ya cargados necesitan recarga para adoptar cambios de codigo o entorno.
- `WEZBRIDGE_AFFINITY=0` / `WEZBRIDGE_AFFINITY_JSON` — control de la afinidad proyecto→agente
  (default: lee `_intel/affinity.json`)
- **Censo de panes en worker (T-0321, 2026-09-04)** — el daemon `:4200` ya NO ejecuta wezterm de
  forma sincrona en su event loop: `src/pane-census.cjs` lanza `src/pane-census-worker.cjs` como
  hijo, que hace `discoverPanes()` y el session-snapshot; waker, watchdog, clawtrol-bridge,
  `/api/panes` y el monitor de auto-handoff leen esa cache. Si una llamada wezterm del hijo pasa de
  `hangMs` sin volver, el padre mata el árbol (`taskkill /T`) y relanza con backoff; el heartbeat
  lleva `last_cli_call {name, started_at, age_ms, in_flight}` y `census {restarts, kills, ...}`, y
  `bridge_health` dice "WEZTERM CLI COLGADA — `wezterm listPanes` lleva 4 min sin volver" en vez de
  "DAEMON DOWN". Config por archivo `_intel/pane-census.json` `{intervalMs, hangMs, silentMs}`
  (defaults 20000/45000/120000); env `WEZBRIDGE_CENSUS_INTERVAL_MS` / `WEZBRIDGE_CENSUS_HANG_MS` /
  `WEZBRIDGE_CENSUS_SILENT_MS` pisan al archivo; `WEZBRIDGE_CENSUS=0` vuelve al camino sincrono viejo.
  Por qué: medido (T-0321 AC1) que `execFileSync` SÍ respeta su timeout, pero bloquea el loop 10 s +
  1 reintento por pane = 240 s con 12 panes: proceso vivo, puerto LISTENING, sin HTTP ni heartbeat.
  Subir timeouts o agregar reintentos EMPEORA esa aritmética.
- **Central de avisos (T-0334, 2026-09-03)** — `WEZBRIDGE_EVENTS_URL` (base del hub de
  personaldashboard, sin `/v1/events`) + `PERSONALDASHBOARD_EVENTS_HMAC_SECRET` (Vaultwarden
  "Homelab - PersonalDashboard emitter wezbridge"): con ambos seteados el telegram-streamer manda
  cada decisión gateada como evento P1 firmado (`src/events-gateway.cjs`, `dedupe_key`=T-id) con 3
  acciones firmadas al tablero (`/act`, `board-app/lib/action-links.cjs`) y **cero** Telegram
  directo. Sin ellos, cae al DM de Telegram. `WEZBRIDGE_BOARD_PUBLIC_URL` = URL del tablero que
  abre el teléfono (LAN/WireGuard). Los tres viven en `wezbridge/.env.local` (gitignored) y los
  carga `scripts/start-telegram-streamer.cmd` al arrancar. Contrato del hub:
  `personaldashboard/docs/CENTRAL-NOTIFICATION-HUB.md`. Diagnóstico: `events.jsonl` lleva
  `via: gateway|telegram` por decisión notificada; un 401 "Invalid event signature" con la receta
  del doc = secreto de Vaultwarden ≠ secreto en el env de producción del hub.

## Restart-on-port-conflict (daemon no rebindea a :4200)
Matar toda instancia stale:
```bash
for pid in $(wmic process where "Name='node.exe' and CommandLine like '%dashboard-server%'" get ProcessId /format:value 2>/dev/null | grep -oE "[0-9]+"); do taskkill //PID $pid //F; done
```

## Dead-man switch (VM, T-0529)
`WezBridge-DaemonSentinel`'s own alert channel (Claude-pane poke) can go
silent, so it also SSHes to the ubuntu VM on every **up** run and touches
`~/omniclaude.heartbeat` (skipped on down/wedged/suspect — VM silence then
means "daemon down" too). VM cron `~/bin/omni-deadman.sh` (`*/15 * * * *`)
alerts to Telegram when that file is stale >1800s, re-alerts every 6h while
stale, sends one "recovered" message when it clears. State:
`~/.omni-deadman.state` (`episode_start`/`last_alert` epochs); test suite:
`~/bin/test-omni-deadman.sh`. Visible without SSH:
`_intel/evidence/wezbridge/deadman-touch.json` (`{ok, at, error?}` or
`{ok:false, skipped:true, reason}`) and `deadman_touch` in every
`daemon-sentinel.jsonl` line.

## Latitud WSL
El operador no usa WSL personalmente — los agentes tienen latitud completa para spawnear panes
WezTerm corriendo `wsl` para testing Linux-only (variantes de install de codex, paths POSIX)
sin preguntar. `spawn_session` + `wsl` como primer comando, o `agent: "shell"`.

## Crash de wezterm
No diagnostiques a mano — corré `npm run restore-session` (o decile al operador: `LEADER+R` /
CTRL+B,R picker). Los snapshots capturan cada 60s con retención de 24h mientras el daemon corre.
Pedido explícito del operador: todo restore pasa por la skill `wezterm-crash-recover`.

## MCP desconectado (varios panes a la vez) — T-0569
Reconectar un MCP (p.ej. MemoryMaster) a mano funciona: `/mcp reconnect <server>` tipeado en
el composer de cada pane contesta `Successfully reconnected to <server>`. El problema es
escalar eso a toda la flota sin tipear en un pane ocupado ni mandar el `/mcp` por un shell
que lo destroza antes de que llegue al CLI.

**Nunca uses Git Bash para el envío.** MSYS reescribe un `/mcp` inicial como un path de
filesystem antes de que el comando llegue al proceso — el `/` inicial nunca sobrevive.
`scripts/mcp-reconnect-broadcast.cjs` evita el problema de raíz: llama `execFile(orcaBin,
argv)` directo (mismo `runOrca` inyectable que `src/orca-census.cjs`), sin shell en el medio.
Si igual envolvés el CLI de orca en un one-liner de Bash, exportá `MSYS_NO_PATHCONV=1` primero.

```
node scripts/mcp-reconnect-broadcast.cjs <server> [--dry-run] [--include-busy-self]
```

- `--dry-run` — lista targets y skips, no manda nada.
- `--include-busy-self` — deja que el pane del propio caller entre al gate normal de
  idle+composer-vacío en vez del skip automático (ver regla de seguridad abajo).
- Exit 0 si todos los panes targeteados clasificaron `ok`; exit 1 si alguno dio `fail` o
  `unknown`, o si el censo de Orca falló.

**Regla de seguridad — nunca se tipea en un pane que no está listo para recibirlo:**
1. Solo panes Orca con `provider=claude` (censo `src/orca-census.cjs`, `orca terminal list`).
2. Solo panes **idle** — mismos patrones `STATUS_PATTERNS` de `src/pane-discovery.cjs`
   (`working`/`permission`/`continuation` primero, `idle` como fallback). Un pane mid-turn
   (`esc to interrupt`, spinner, verbo+`…`) nunca recibe el envío.
3. Solo panes con el **composer vacío** — reusa `composerContent` de
   `scripts/composer-state.cjs`. Un pane `idle` con texto sin enviar en el composer igual se
   skipea (`composer-not-empty`): un Enter ahí mandaría el texto ajeno pegado al comando.
4. **El pane del propio caller** (`process.env.ORCA_TERMINAL_HANDLE`, seteado por Orca en
   todo terminal que spawnea) se skipea por default como `skip:self-busy` — está corriendo el
   script, tipearle es peor que no reconectarlo. El comando exacto para reconectarlo a mano
   (PowerShell u orca CLI directo) se imprime en la columna `excerpt` de esa fila.

Cada pane no-targeteado sale como `skip:<razón>` en la tabla — nunca se tipea "por las
dudas". El resultado de cada envío real se clasifica leyendo la pantalla completa (no solo
las últimas líneas: un pane ocupado con un agente en background sigue imprimiendo después
del resultado del reconnect y lo empuja fuera de una ventana angosta — medido en vivo,
T-0569) hasta 10 s: `ok` si aparece "Successfully reconnected", `fail` si aparece texto de
error, `unknown` si se agota el tiempo sin ninguno de los dos.

## Mux-wedge — LEER ENTERO ANTES DE ACTUAR
Observado UNA vez, 2026-07-02, en wezterm 20240203. El build instalado es muy posterior
(chequeá `wezterm --version`; era `20260731` al 2026-08-19), así que puede no reproducir más.
Churn rápido de spawn/kill (loops e2e) podría wedgear el mux listener del GUI — todo
`wezterm cli` ETIMEDOUTea mientras la ventana GUI sigue andando.

**Un mux LENTO y un mux WEDGEADO producen la firma IDÉNTICA, y los remedios son opuestos.**
`wezterm.reachable: false` solo NO es evidencia de wedge. Medido 2026-08-19: el mismo mux
respondió en 191 ms por CLI directo, después silencio pasado un presupuesto de 25 s, con todos
los panes sanos — la causa era LA MÁQUINA (un `tsserver.js` filtrado reteniendo 25 GB, 1,4 GB
libres de 63,8), no WezTerm. Liberada la memoria, la misma sonda tomó 612 ms.

En orden: **(1)** chequeá memoria libre y CPU antes de culpar a wezterm; **(2)** llamá
`bridge_health` de nuevo un minuto después — la contención VARÍA entre lecturas, un wedge real
nunca contesta. `probeMux`/`classifyMuxProbe` (`src/wezterm.cjs`) ya codifican esto: respuesta
tardía = `degraded`, silencio total = `inconclusive`, nunca un wedge confiado. **(3)** Solo tras
silencio total repetido considerá reiniciar WezTerm — es el fix conocido de un wedge real Y mata
todos los panes vivos: confirmá una captura fresca de `vault/_wezbridge/session-snapshot.jsonl`
primero y esperá correr `npm run restore-session` después.

## GUI colgado, mux sano ("not responding" con los panes trabajando)
Tercer caso, distinto de los dos de arriba. Medido 2026-09-01 (4 GUIs colgados en 3 días,
diagnóstico completo en `artifacts/2026-09-01-wezterm-gui-hang-diagnosis.html`):
`wezterm-gui.exe` da `Responding=False`, su thread principal gira al 100% de un core en código
de wezterm (no del driver de GPU) y pierde ~2 MB/s; los `wezterm-mux-server` quedan al 0% con
los panes sanos. Mejor coincidencia upstream: wezterm#7388 / PR #8023 (foco en ping-pong en el
cliente mux; abierto). No hay commit para aplicar: el remedio es reemplazar el GUI.

**Lo que vuelve irrecuperable el cuelgue es el robo de `sock`, no el cuelgue.** Un
`wezterm cli` SIN `--no-auto-start` que no logra conectar arranca un `wezterm-mux-server`
nuevo, y ese mux borra y re-crea `~/.local/share/wezterm/sock` apuntando a sí mismo. El mux
viejo sigue vivo con los panes pero sin path; un GUI nuevo `--attach` se cuelga del mux vacío.
`logs/recorder.log` registra cada `mux-startup`: tres seguidos con 10 s de distancia = un loop
de sondas. Por eso **toda** invocación `wezterm cli` del repo lleva `--no-auto-start`
(`test/wezterm-cli-no-auto-start.test.cjs` lee `src/` y `scripts/` y falla si aparece una sin
el flag). Si tenés que sondear un socket a mano: `wezterm cli --no-auto-start list`.

**Recuperación:** la tarea programada `wezbridge-gui-watchdog` (cada 1 min,
`scripts/gui-watchdog.ps1`) confirma el cuelgue dos veces con 30 s de distancia y corre
`~/scripts/Recover-WezTermGui.ps1`, que lanza un GUI de reemplazo adjunto al dominio `unix`,
prueba que el conteo de tabs coincide y recién entonces mata el colgado (así funcionó el
2026-08-30 21:07 con 11 tabs intactos). Si no puede probar el conteo se niega y el watchdog
cierra el reemplazo huérfano; dos intentos por PID y después queda para una persona. Log:
`%LOCALAPPDATA%\WezTerm\gui-watchdog.log` (`hung_confirmed`, `recover_exit`, `mux_split`).
`mux_split owners=…` con más de un dueño = el socket ya fue robado: sólo queda esperar a que
las sesiones huérfanas queden ociosas, matar GUI + mux-servers y
`npm run restore-session -- --domain unix` (sin `--domain` los panes caen en el dominio local
del GUI y mueren con el próximo cuelgue). **Nunca arranques `wezterm-mux-server` desde un pane
de Claude/Codex:** cada pane del mux hereda el env del server, y con `CLAUDE_CODE_CHILD_SESSION`
heredado las sesiones restauradas arrancan con "Transcript saving is off" (medido 2026-09-01
18:35, hubo que reiniciar el mux con el env limpio y restaurar de nuevo). Arrancalo desde un
shell limpio o dejá que el GUI lo levante solo al adjuntar el dominio.

**Para la próxima vez, stack del thread que gira** (WinDbg instalado vía winget):
```
cdb -pv -p <PID> -c "~~[<TID hex>]s; k 40; !runaway 7; q"
```

## Fleet digest (T-0409, S6) — qué despierta al Fleet, y qué no

`src/fleet-digest.cjs` + `scripts/fleet-digest.cjs` clasifican cada línea de
`_intel/pane-events.jsonl` (escrita por `src/orca-census.cjs` — `worker-done`, `suborch_done`,
`suborch_question`, `suborch_status`, `suborch_handoff`) en `immediate` | `digest` | `drop`:

- **`immediate`** (se envía al toque): `suborch_question`, y `worker-done`/`suborch_done` con
  `outcome=failed`.
- **`digest`** (se acumula y sale UN mensaje cada 30 min, `--window`, agrupado por lane):
  `worker-done`/`suborch_done` con `outcome` succeeded o ausente, y `suborch_handoff`. Un
  `immediate` también aparece en el digest de su ventana — se manda solo Y queda listado.
  Una ventana sin eventos `digest` no genera nada (nunca un digest vacío).
- **`drop`** (nunca despierta a nadie): `suborch_status`, `turn-end`, `permission-wait`, y
  cualquier línea que sea un eco de brief/plantilla (`ECHO_MARKERS`, reusado de
  `orca-census.cjs`). Un `event` NUEVO que el archivo nunca tuvo antes cae en `digest` por
  default (superficie, no desaparece en silencio) — ver el comentario de `classifyEvent`.

**Por qué reemplaza al waker.** El `orchestrator-waker` viejo (poke a un pane WezTerm) está
DESARMADO desde el 20/09 y no puede alcanzar terminales Orca — ver
`_intel/briefs/2026-09-24-T0409-scope-REPORT.md`. Sigue en el repo como legado WezTerm-only;
NO se re-arma acá. `pane-events.jsonl` ya recibe los eventos de Orca (T-0525/T-0555); este
digest es el reemplazo.

**Uso:**
```
node scripts/fleet-digest.cjs                                          # un tick dry-run (default; imprime, no manda nada)
node scripts/fleet-digest.cjs --send                                   # un tick REAL (llama notify_orchestrator.py) — nada en este repo lo programa
node scripts/fleet-digest.cjs --dry-run --replay --from <iso> --to <iso>   # predicción SIN estado, sobre el pane-events.jsonl real
node scripts/fleet-digest.cjs --count-day YYYY-MM-DD                   # envíos registrados ese día UTC
```
`--dry-run` es el modo por default. `--send` es el ÚNICO modo que llama a
`scripts/orchestration/notify_orchestrator.py` (la cola de outbox durable que ya usa Foreman);
esta carta no registra ningún schtask/loop que lo dispare — eso queda gateado al operador,
mismo precedente que T-0418.

**Estado durable** en `_intel/.fleet-digest/` (nunca tocado por `--replay`, que es de solo
lectura): `cursor.json` (mismo shape que el cursor de `orchestrator-waker.cjs`: `{bytes, tail:
{len, hash}}` — detecta rotación/truncamiento del jsonl), `pending-digest.json` (ventana en
curso) y `sent.jsonl` (una línea por envío: `{at, kind, n_events, lanes, message_sha1,
delivered}`; `delivered` es `null` en dry-run). **`--count-day` reemplaza a `daemon-err.log`
como instrumento de S6** — ese log está muerto desde el 06/09 (ver el scope report).

**Medición S6 (réplica, sin mandar nada):** `--dry-run --replay --from 2026-09-23T00:00Z --to
2026-09-24T00:00Z` contra el `pane-events.jsonl` real predijo **4 envíos/día** sobre 397 eventos
crudos ese día (`test/fleet-digest.test.cjs`, AC4) — bien debajo del umbral de <10 de S6. El
lane se resuelve con `src/lane-roster.cjs` (terminal → lane vía `_intel/orchestrators.json`);
sin match, cae al `repo` del evento.

**Watcher crudo (`scripts/pane-event-watcher.py`):** sigue imprimiendo TODO evento sin filtrar
por default (sin cambios — cambiar ese default es decisión del Fleet, no de esta carta).
`--kinds suborch_question,suborch_done,worker-done` restringe la salida a esos `event`. Tests:
`scripts/test_pane_event_watcher.py -v` (no corre dentro de `npm test`, mismo patrón que
`scripts/orchestration/test_codex_worker.py`).

<!-- doc-head: Runtime operation, recovery and removal of pane-count limiting -->
Read for environment settings, MCP reload boundaries, mux identity, GUI recovery and Orca transport.
Pane-count limiting was removed by operator decision 2026-09-10; legacy env limits are ignored. Gmail routine transport: headless (T-0339, unmigrated).
Source edits do not update already-loaded MCP processes. `scripts/quota-dispatcher.cjs`/`foreman-supervisor-jev.cjs` retired (T-0582).
T-0599 (2026-09-24): decision-relay + orchestrator-waker WezTerm-sender disposition, see "Otros senders migrados a Orca". Fixup: daemon-heartbeat-sentinel.cjs's deliverPoke (missed originally) migrated too.
curandero daemon-4200-dead probea /health sin -L: ya daba 503 antes de este cambio; su correccion (usar /api/health) es T-0593 en infra.
Sección "Automation → ledger router (T-0598)": inventario, contrato de findings JSON
(`_intel/automation-findings/<task>-<fecha>.json`), `scripts/automation-router.cjs` — única vía
por la que una tarea programada entrega algo accionable como tarjeta del ledger + a2a_send.
Fase B (2026-09-24): schtask `Wezbridge-AutomationRouter` YA registrado (cada 15 min, ver "Fase B
— el schtask... YA está registrado"); DaemonSentinel migrado al contrato; gap de sender T-0600.
<!-- /doc-head -->

# Operations — env vars, restart, crash recovery, mux-wedge + GUI-hang triage (wezbridge)
> Qué cubre: variables de entorno útiles, el gotcha de rebind del daemon :4200, latitud WSL,
> recuperación de crash de wezterm, el triage mux-lento-vs-mux-wedgeado (firmas idénticas,
> remedios opuestos), el tercer caso GUI colgado con mux sano (2026-09-01), el broadcast de
> `/mcp reconnect <server>` a todos los panes Orca Claude idle (T-0569), el transporte Orca
> (T-0596: resolver, self-send guard, backlog seal, CLI para scripts, flag legado de WezTerm), y
> el router de automatizaciones programadas → ledger (T-0598: contrato de findings JSON,
> `scripts/automation-router.cjs`).
> Leer cuando: el daemon no rebindea, wezterm crasheó, todo ETIMEDOUTea, un GUI dice "not
> responding", hay >1 wezterm-mux-server, un MCP aparece desconectado en varios panes, vas
> a setear env de guards/grader/inbox, tocás qué despierta al Fleet (digest/waker), tocás quién
> entrega un `a2a_send`/queue-drain (Orca vs. WezTerm legado), o vas a agregar/migrar una tarea
> programada que produce algo accionable.
> Términos clave: WEZBRIDGE_*, restore-session, probeMux, degraded, inconclusive,
> session-snapshot, --no-auto-start, gui-watchdog, Recover-WezTermGui, mux_split,
> espacio único de pane_id (--prefer-mux + sock, T-0260), WEZBRIDGE_PREFER_MUX=0, gui_only,
> dead-man switch (VM omni-deadman.sh + DaemonSentinel touch, T-0529), deadman-touch.json,
> mcp-reconnect-broadcast.cjs, skip:self-busy, ORCA_TERMINAL_HANDLE, fleet-digest, classifyEvent,
> --count-day, orchestrator-waker (legado, desarmado), orca-target.cjs, orca-send.cjs,
> ORCA_DRAIN_NOT_BEFORE, WEZBRIDGE_DRAIN_NOT_BEFORE, WEZBRIDGE_WEZTERM_TRANSPORT,
> a2a-send-cli.cjs, automation-router.cjs, automation-finding-schema.cjs, emit-finding.cjs,
> automation-findings, router-state.json.

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
- **Rutina gmail-recordatorios headless (T-0339, 2026-09-24)** — `node scripts/gmail-recordatorios-run.cjs run`
  (el schtask, sin cambios) corre la rutina como `claude -p` headless (`src/gmail-routine-headless.cjs`):
  Gmail solo lectura, `--permission-mode dontAsk`, sin shell, sin `--bare` (este fuerza auth por API key y pierde
  los conectores claude.ai). `--via pane` o `GMAIL_ROUTINE_VIA=pane` vuelve al poke por pane (solo WezTerm).
  `GMAIL_ROUTINE_CLAUDE_BIN` pisa el ejecutable (default: `claude.exe` real detras del shim npm `.cmd`).
  Exit del run: 0 ok · 3 spawn · 4 claude salio sin complete/fail o con error · 8 timeout (15 min) ·
  9 otro run sigue `dispatching` (no lanza un segundo hijo) · 10 completo sin ninguna busqueda Gmail
  (findings void "completion sin consulta a Gmail"). El registro guarda solo metadata: conteos por herramienta y bytes.

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

## Transporte Orca — a2a_send y queue-drain (T-0596, 2026-09-24)

Decisión operador/Fleet 24/09: la flota vive en terminales Orca; WezTerm tiene 0 panes. Orca es
el transporte por default para `a2a_send({to_project})` y para el drenaje de cola
(`project-queue.cjs`'s `findTarget`/`deliverPending`, usado por `scripts/queue-drain.cjs`).

- **Resolver único:** `src/orca-target.cjs`'s `resolveOrcaTarget(wanted)` — censo Orca
  (`orca-census.cjs`) cruzado contra el roster de lanes (`lane-roster.cjs`) y resuelto con
  `pane-identity.cjs`'s `resolveOrca`. Compartido por los DOS call sites (`a2a_send` en
  `mcp-server.cjs` y `project-queue.cjs`'s `findTarget`) para que no diverjan — la misma clase
  de bug que ya existía para resolución WezTerm.
- **Entrega:** `src/orca-send.cjs`'s `sendToOrcaTerminal(handle, body)` — `orca terminal send
  --enter` seguido de una lectura de pantalla (`orca terminal read --screen`) para VERIFICAR que
  el cuerpo aterrizó y no quedó en el composer, mismo vocabulario `submitted`/`delivered` que
  `verified-send.cjs`. El retry de Orca NO es un id elegido por el llamador: si Orca rehúsa con
  "ambiguous transport failure" devuelve un `orchestrationRequestId`, y ESE es el único id válido
  para `--retry-request` — `orca-send.cjs` reintenta internamente con ese id, una vez.
- **Self-send guard:** un terminal Orca no puede resolverse a sí mismo como destino. Identidad
  propia: `process.env.ORCA_TERMINAL_HANDLE` (seteado por Orca en TODO terminal que spawnea,
  igual que la regla de self-skip de `mcp-reconnect-broadcast.cjs` arriba). `a2a_send` rehúsa
  ANTES de transporte (no encola, no reintenta); `deliverPending` dropea la entrada con el mismo
  motivo. No hay equivalente Orca del fallback census-corrected de `WEZTERM_PANE`: un terminal no
  puede leer su propio handle desde `orca terminal list`.
- **Backlog seal:** `ORCA_DRAIN_NOT_BEFORE` (constante, `2026-09-24T18:00:00Z`) o
  `WEZBRIDGE_DRAIN_NOT_BEFORE` (env, override para tests) — ninguna entrada de cola encolada
  ANTES de ese corte se re-entrega por la rama Orca, aunque siga dentro del `maxAgeMs` de 24h.
  Decisión operador 24/09: las ~30 aprobaciones/relays encolados antes de que existiera el drain
  Orca "ya están en el ledger y ejecutadas" — no deben replayearse. Scoped a la rama Orca
  únicamente; nunca afecta tráfico WezTerm-pane del mismo día.
- **Scripts no-MCP:** `bin/a2a-send-cli.cjs` — entry point de una sola llamada JSON-RPC contra
  `mcp-server.cjs` real, para que los dispatchers Python (`scripts/orchestration/
  notify_orchestrator.py`, `task_router.py`) pasen por `a2a_send` en vez de tipear `orca terminal
  send` a mano. TODO control de `a2a_send` (gate, shape, lease, cola, self-send guard, audit)
  aplica también a estos llamadores.
- **WezTerm legado, apagado por default (T-0596 item 4):** la resolución/entrega vía pane WezTerm
  en `a2a_send` y en `findTarget`/`deliverPending` está detrás de `WEZBRIDGE_WEZTERM_TRANSPORT=1`
  (default: no seteada = off). Con el flag off, Orca se resuelve PRIMERO y es el único transporte
  por default; un destino que solo resolvería vía WezTerm queda encolado con motivo, nunca
  silenciosamente descartado. `send_prompt` queda marcado deprecated para mensajería de flota en
  su descripción de tool (usar `a2a_send`) pero sigue siendo uno de los tools WezTerm-only
  (`discover_sessions`, `send_prompt`, `read_output`, `send_key`, `get_status`, `list_projects`,
  `kill_session`, `set_tab_title` — retirarlos es una carta aparte, no ésta).

**Regla dura de smoke-testing:** nunca probar entrega en vivo contra el pane/terminal que la pide
— usar el doble de Orca (`test/mocks/orca-mock.cjs`) o un terminal idle distinto. Un smoke que se
manda a sí mismo mide el self-send guard, no la entrega.

## Otros senders migrados a Orca (T-0599, 2026-09-24)

Un verifier sobre el PR de T-0596 encontró otros senders que seguían entregando por WezTerm
contra un pane id ya resuelto — muertos con la flota en Orca. Por sender:

- **`decision-relay.cjs`** (el sobre `[decision] operator approved/cancelled ...`): por default
  ahora resuelve/entrega con las MISMAS `resolveOrcaTarget`/`sendToOrcaTerminal` que `a2a_send`;
  WezTerm queda detrás de `WEZBRIDGE_WEZTERM_TRANSPORT=1`. Backlog seal propio (AC4): una decision
  con `at` anterior a `ORCA_DRAIN_NOT_BEFORE`/`WEZBRIDGE_DRAIN_NOT_BEFORE` nunca se entrega en
  vivo — se resuelve `decision.undeliverable` (`reason: backlog-sealed`) sin reintento. Detalle
  completo y la razón de NO enrutar por el handler completo de `a2a_send` (lease/cola duplicada):
  `_intel/briefs/2026-09-24-T0599-wezterm-senders.md` y `docs/a2a-protocol.md`'s sección T-0599.
- **`orchestrator-waker.cjs`**: sigue siendo WezTerm-only (pokea pane-0 fijo, sin equivalente
  Orca) pero ahora tambien exige `WEZBRIDGE_WEZTERM_TRANSPORT=1` ademas de su propio
  `WEZBRIDGE_ORCH_WAKER=1` — sin el flag de transporte, el daemon lo reporta `armed:false,
  deliberate:true` en vez de armarlo contra un transporte muerto.
- **`gmail-routine-dispatch.cjs`**: inventariado, SIN TOCAR — bajo observacion en vivo para
  T-0339 hasta que corran las pasadas del 25 y 26/09 08:30 ART.
- **`scripts/daemon-heartbeat-sentinel.cjs`'s `deliverPoke`** (fixup, faltaba del inventario
  original): el poke de la tarea programada de Windows `WezBridge-DaemonSentinel` (cada 5 min)
  entregaba directo contra un pane WezTerm resuelto por `findOrchestratorPane()`, sin flag ni
  camino Orca — con la flota en Orca, el poke no llegaba a nadie. Ahora `deliverPoke` despacha a
  `deliverPokeOrca` (default, mismas `resolveOrcaTarget`/`sendToOrcaTerminal` que `a2a_send`,
  proyecto `wezbridge`/`WEZBRIDGE_ORCH_REPO`, self-send guard vía `ORCA_TERMINAL_HANDLE`) o a
  `deliverPokeWezTerm` (legado, detrás de `WEZBRIDGE_WEZTERM_TRANSPORT=1`). Dedupe/cooldown/
  deadman de `evaluate()` sin tocar.

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

**Flake conocido:** `test/fleet-digest.test.cjs` AC4 necesita un `_intel/pane-events.jsonl`
REAL y vivo del checkout del operador para reproducir la medición de arriba — en un worktree
aislado (sin ese archivo, o con uno distinto) el conteo no matchea y el subtest falla. No es un
bug del digest; es una medición contra estado externo. Ver también los flakes de worktree
documentados en briefs de T-0596 (lane-hooks p95 de timing, model-tiers.json ENOENT, daemon-cli,
mcp-server timeouts, tasks-watcher) — todos reproducibles solo con estado del checkout real, no
del worktree aislado.

**Watcher crudo (`scripts/pane-event-watcher.py`):** sigue imprimiendo TODO evento sin filtrar
por default (sin cambios — cambiar ese default es decisión del Fleet, no de esta carta).
`--kinds suborch_question,suborch_done,worker-done` restringe la salida a esos `event`. Tests:
`scripts/test_pane_event_watcher.py -v` (no corre dentro de `npm test`, mismo patrón que
`scripts/orchestration/test_codex_worker.py`).

## Automation → ledger router (T-0598, 2026-09-24)

> Qué cubre: por qué existía el problema (tareas programadas que producen algo accionable y
> nadie lo convierte en trabajo), el inventario de automatizaciones vivas, el contrato de
> findings JSON, y `scripts/automation-router.cjs`. Leer cuando: vas a agregar una automatización
> programada nueva, o a migrar una existente al contrato (Fase B).

Regla del operador (24/09): toda tarea programada (PC Task Scheduler, cron de la VM, Hermes,
crons de panes) que corre para algo que requiere acción **tiene que entregarlo al carril/proyecto
dueño** — nunca como un log que nadie lee, ni como una sesión interactiva que queda viva sin
convertir nada en trabajo (medido: el curador nocturno WISP corrió como sesión interactiva y
quedó viva 8h sin entregar nada).

### Inventario (Fase A)

**Corrección (T-0598 fixup):** `wezbridge/_intel/briefs/audit-automations-2026-09-22/{A-local,B-vm,C-hermes}.md`
SÍ existen — quedaron como archivos untracked en el checkout principal del operador (nunca
commiteados a ningún branch, por eso el `git log --all --diff-filter=A` de la primera entrega no
los encontró). Son 3 auditorías read-only del 2026-09-22 (206/142 líneas Track A local-PC,
297/142 Track B VM, 347 líneas Track C Hermes/MemoryMaster-sync). La tabla de abajo se reconstruyó
de esas tres fuentes; cada fila cita el archivo de origen. Filas sin dueño explícito en la fuente
están marcadas `inferred` (repo asignado por dominio, cruzado contra `Py Apps/FLEET.md`).

| Automatización | Dónde corre | Trigger | Salida hoy | ¿Accionable? | Repo dueño | Fuente |
|---|---|---|---|---|---|---|
| `nocturnal_rf_audit_sweep.py` (curador nocturno WISP) | VM, cron | diario 03:15 | log + heartbeat Kuma confirmado; "Core: PASS" | Sí — hallazgos de RF/drift accionables (antes corría como sesión interactiva viva ~8h sin cerrar) | whatsappbot-final (inferred: dominio WISP) | B-vm.md L49 |
| `mailpit-to-telegram.py` | VM, cron cada minuto | cada minuto | **100% fallando** (`URLError: Connection refused`, contenedor sin puerto publicado); único canal de magic-links SuperSync | Sí — P0, nadie recibe el link de login/recovery | whatsappbot-final (inferred: dueño de SuperSync) | B-vm.md L38, L61, L83-91 |
| `personaldashboard-life-source-collector.service` | VM, systemd timer | ~15 min | **fallando desde 2026-09-01** (583+ fallos en journal retenido), fuente `personal_whatsapp` en error | Sí — P1, root cause sin diagnosticar | infra (PersonalDashboard) | B-vm.md L68, L93-100 |
| `reboot-askey.js` (reboot preventivo router Askey) | VM, cron diario 04:30 | diario | **falla todos los runs** desde el pin de Playwright chromium quedó desactualizado (1208 vs 1223 instalado) | Sí — P1, router sin reboot preventivo hace 2+ semanas | whatsappbot-final | B-vm.md L23, L70, L102-109 |
| `canary-monitor.sh` | VM, cron diario 02:35 | diario | log detenido desde 2026-05-09 (4.5 meses), cron sigue disparando pero sin output | Sí (inferred) — P2, estado real desconocido | whatsappbot-final (inferred) | B-vm.md L25, L75, L119-125 |
| `puntofutura-archive-missing-demo-sites` | VM, cron.d diario 02:20 | diario | **muerto** — el `cd` al directorio del proyecto falla, nunca llega a loguear nada | No — P2, es limpieza; accionable solo como chore de cron | infra (`/etc/cron.d`) / local-biz-sites | B-vm.md L53, L69, L111-116 |
| `winback_watcher.py` | VM, cron cada minuto (**pausado** desde 2026-09-22, dictamen P0) | minuto a minuto | acciones directas (reactiva/factura) cuando hay SÍ explícito con oferta calzada | Sí, pero ya actúa él mismo — no es un finding huérfano | whatsappbot-final | B-vm.md L47 |
| `WezBridge-DaemonSentinel` | PC, schtask cada 5 min | cada 5 min | toca `deadman-touch.json`; detección correcta durante el outage de 70.2h del daemon, pero **la entrega falló 157/199 veces** por falta de pane wezbridge vivo (único canal, sin fallback ntfy) | Sí — el daemon caído es accionable; el gap real es delivery, no detección | wezbridge | A-local.md L15, L138-181 |
| `omni-deadman.sh` (dead-man's switch VM→PC) | VM, cron `*/15 * * * *` | cada 15 min si trip | heartbeat producer ausente desde **2026-06-14** (~100 días); única alerta ya disparada nunca se re-armó | Sí — P1, es el único watchdog cruzado VM↔PC | wezbridge (cross-cutting con infra/VM) | A-local.md L44, L52-64, tabla ledger #1 |
| `Infra-Git-Autopush` | PC, schtask diario 04:30 | diario | rojo 2 días seguidos (falso positivo del secret-scanner sobre `infra/scratch/*.py`); no llega a Kuma por diseño, nada más lo escala | Sí — P0, drift de commits sin push acumulando de nuevo | infra | A-local.md L17, L65-69, tabla ledger #3 |
| Foreman (`scripts/orchestration/foreman.py`) / `notify_orchestrator.py` | PC, invocado dentro del proceso Bash de una sesión agente viva | manual, 4h poll loop | supervisión de tarea; `notify()` puede devolver `False` silenciosamente si `orca terminal list` falla, sin retry/cola/fallback | Sí — P1, ya es el patrón que el propio comentario de `run-fleet-steward.cmd` advierte evitar | wezbridge | A-local.md L25-26, L38-40, tabla ledger #2 |
| `wezbridge-fleet-steward` / `-steward-gate` | PC, schtask diario 09:00 + gate 09:05 | diario | findings del steward (ya integrados al ledger vía su propio camino); el RED de steward-gate no llega proactivamente al operador — `decision-relay` sin caller vivo desde 2026-08-13 | Ya migrado a su propio contrato — fuera de alcance de este router (el gap de notificación es su propio ledger card T-0415) | wezbridge | A-local.md L19-20, tabla ledger #4 |
| `wezbridge-queue-drain` | PC, schtask cada 5 min | cada 5 min | reintenta sobres A2A encolados | No es un finding — es infraestructura de entrega | wezbridge | (mecanismo ya documentado arriba en T-0596, sin fila propia en A-local/B-vm/C-hermes) |
| `routine-test-strength-wezbridge` | PC, schtask semanal (sáb 04:00) | semanal | `_intel/routine-findings/*.json`, consumidos por `routine-audit.cjs` (mecanismo C, ya contractual) | Ya migrado (mecanismo C) — fuera de alcance | wezbridge | A-local.md L24 |
| gmail-recordatorios (`src/gmail-routine-*.cjs`) | wezbridge (headless, T-0339) | según config del routine | resultado del envío (éxito/fallo); en A-local aparece como `wezbridge-gmail-recordatorios` con `rc=4` repetido ("no unambiguous project/cwd target") cuando el lane wezbridge no tenía panes ejecutores | Sí (fallo de envío es accionable) | wezbridge — **bajo observación T-0339, no migrar antes del 26/09 08:30 ART** | A-local.md L21 |
| `hermes-sync.sh` / `windows-hermes-sync.ps1` (MemoryMaster delta sync) | VM cron 03:00/15:00 + PC schtask 04:00/16:00 | 2x diario cada lado | `"ok": true` todos los runs, pero con warning crónico cada ciclo: "Schema version unknown... merging without a compatibility guarantee" + 907 filas legacy en cuarentena cada vez | Sí — P1, root cause del schema-version desconocido sin investigar | memorymaster | C-hermes.md L100-127, tabla ledger #3 |
| `Cron Health Auditor` / 6 jobs Hermes-VM habilitados (Security Scan, Self-Healing Infra Monitor, Docker Cleanup, MM weekly hygiene, Supplier Price Monitor, Infra Weekly Review) | VM, Hermes cron (`~/.hermes/cron/jobs.json`) | variable (diario/semanal) | los 7 jobs habilitados reportan `last_status: ok`, `failure_streak: 0` — sanos al momento de la auditoría | No accionable hoy (estado verde); el propio Cron Health Auditor ya cubre este dominio | wezbridge (inferred: consumidor de Infra Weekly Review) / infra | C-hermes.md L72-94 |
| `MemoryMaster-Checkpoint-Daily` | PC, schtask diario 11:25 | diario | último run Result `3` (no-cero), sin investigar en ninguna de las 3 auditorías | Sí (inferred) — P2, root cause pendiente | memorymaster | A-local.md L18, C-hermes.md L103, L234-243 |
| `hermes-centinela-tick` (perfiles `centinela`, `wabot-curador`) | PC (Hermes local, Windows), schtask cada 10 min | cada 10 min | `Result: 0` del wrapper, pero el log de fondo muestra `HTTP 429` repetidos contra `openai-codex` el 2026-09-17/18 sin re-verificar si se recuperó; el wrapper puede estar tragándose el fallo real detrás de un exit code limpio | Sí (inferred) — P2, hay que confirmar si `Result: 0` refleja el trabajo real | wezbridge (inferred: consumidor del centinela) | C-hermes.md L256-266, L287-299 |
| Telegram local Hermes (`telegram_polling_conflict`) | PC, gateway Hermes local | continuo | estado `fatal` desde 2026-08-28 (~3.5 semanas); token de bot compartido con la instancia VM, que gana el long-poll | Sí (inferred) — cualquier job local futuro que entregue por Telegram fallará silenciosamente | infra | C-hermes.md L307-321, tabla ledger #6 |
| `infra-coolify-drift-check` | PC, schtask cada 15 min | cada 15 min | drift check (**last=2** medido, i.e. viene fallando) | Sí — drift es accionable | infra | (no cubierto en A-local/B-vm/C-hermes; retenido de la primera entrega, sin re-verificar en este fixup) |

Mecanismo C (`scripts/routine-registry.cjs` + `routine-audit.cjs`, `_intel/routine-findings/`) y
el steward (`wezbridge-fleet-steward`) YA convierten sus hallazgos en trabajo por su propio
camino — no se migran a este router, que cubre el resto: automatizaciones que hoy solo escriben
log/Telegram/sesión sin dueño.

### Contrato de findings JSON

Cada automatización que detecta algo accionable escribe UN archivo en
`_intel/automation-findings/<task>-<YYYYMMDD[-HHMM]>.json`:

```json
{
  "task": "wisp-nocturnal-sweep",
  "repo_owner": "whatsappbot-final",
  "actionable": true,
  "summary": "RF drift detected on sector 12",
  "evidence": "kuma check #124 flapped 3x between 02:00-03:00 ART",
  "severity": "high",
  "fingerprint": "opcional — ver regla abajo",
  "kind": "opcional — default 'general', ver KIND_MAP en scripts/automation-router.cjs"
}
```

Campos requeridos: `task`, `repo_owner`, `actionable` (bool), `summary`, `evidence`, `severity`
(`low|medium|high|critical`). Validado por `src/automation-finding-schema.cjs` — inválido o
`repo_owner` ausente ⇒ el router lo pone en cuarentena, nunca crashea.

**Regla de fingerprint** (para dedupe): si el finding trae `fingerprint`, se usa tal cual (la
automatización conoce mejor su propia identidad — p.ej. un id de servicio UISP). Si no, se
deriva: `sha256(task + "|" + normalize(summary)).slice(0,16)`, con `normalize` = trim + lowercase
+ colapsar espacios. Dos findings con el mismo `task` y el mismo `summary` (salvo espacios/mayús-
culas) dedupean al mismo fingerprint.

Helper para emitir un finding desde cualquier automatización: `bin/emit-finding.cjs` (ver su
propio doc-head para el flag-by-flag).

### `scripts/automation-router.cjs`

```
node scripts/automation-router.cjs [--dir <findings-dir>] [--file <path>]
  [--ledger-cli <path>] [--a2a-cli <path>] [--state-file <path>] [--from-pane <n>]
```

- Escanea `_intel/automation-findings/*.json`, o procesa un único `--file` (para invocarlo al
  final de UNA automatización, sin esperar el barrido de 15 min).
- JSON inválido, o falta un campo requerido (p.ej. `repo_owner`) ⇒ **cuarentena**
  (`_intel/automation-findings/quarantine/`) + línea en `router-log.jsonl`. El proceso sigue con
  el resto de los archivos — un finding roto nunca frena la corrida.
- `actionable:false` ⇒ solo log (`_intel/automation-findings/non-actionable.jsonl`), 0 tarjetas,
  0 sends; el archivo se mueve a `processed/`.
- `actionable:true` ⇒ **una** tarjeta `ready` en el repo dueño vía `_docs-curation/ledger.cjs
  create --origin <fingerprint>` (el ledger YA es idempotente por `origin_key`: reimportar el
  mismo fingerprint devuelve la tarjeta existente en vez de duplicarla) + un `a2a_send` al carril
  dueño vía `bin/a2a-send-cli.cjs --corr <cardId>`. El estado de entrega (`delivered`) por
  fingerprint se persiste en `_intel/automation-findings/.router-state.json`: si el `a2a_send`
  falla, la tarjeta YA existe y el archivo del finding se queda en su lugar — la corrida
  siguiente reintenta SOLO el send, nunca crea una segunda tarjeta. El archivo se mueve a
  `processed/` recién cuando `delivered:true`.
- `--ledger-cli` / `--a2a-cli` (o los mismos paths por defecto, resueltos junto a este repo) son
  inyectables a propósito: los tests (`test/automation-router.test.cjs`) los apuntan a un doble
  de ledger (`test/mocks/fake-ledger-cli.cjs`, que graba cada invocación y no toca el ledger real)
  y al `bin/a2a-send-cli.cjs` real pero apuntado a los mocks de WezTerm/Orca que ya usa
  `test/a2a-send-cli.test.cjs` — así ningún test crea una tarjeta real ni manda un a2a real.
- `--from-pane`: un run programado no tiene pane WezTerm propio, así que `a2a_send` no puede
  probar identidad por censo — hace falta un `--from-pane` explícito (o
  `WEZBRIDGE_AUTOMATION_FROM_PANE`). Fase B lo fija al registrar el schtask del router.
- Seguro de correr cada 15 min: nunca borra un finding (se mueve a `processed/` o `quarantine/`,
  nunca `unlink`).

Mapeo `kind` (finding → `ledger create --kind`): `bug → test-repair`, `incident → general`,
`observability → observability`, `docs → docs`; cualquier otro string se pasa tal cual (el propio
ledger lo resuelve contra `_intel/kinds.json` — un kind desconocido cae a `general` con flag); sin
`kind` en el finding, default `general`. Ver `KIND_MAP` en `scripts/automation-router.cjs`.

### Plan Fase B (NO ejecutado en esta entrega — solo el plan)

| Automatización | Cambio exacto | Cómo probarlo | Riesgo |
|---|---|---|---|
| Curador nocturno WISP | Migrar la sesión interactiva a un turno `claude -p` headless que termina solo y al final llama `bin/emit-finding.cjs` con el hallazgo del sweep | Corrida real en la VM → tarjeta aparece en whatsappbot-final con evidencia del sweep, a2a delivered:true | Toca RF/UISP de clientes reales; un finding mal formado en cuarentena silenciosa no avisa a nadie — Fase B debería además loguear cuarentena a Telegram |
| DaemonSentinel | Al detectar el daemon caído, además de tocar `deadman-touch.json`, emitir un finding (`actionable:true`, repo `wezbridge`) | Matar el daemon a propósito, esperar el próximo tick (5 min), ver la tarjeta | Un blip transitorio generaría ruido — necesita un umbral antes de emitir, no cada tick |
| gmail-recordatorios | Al final del run headless, emitir un finding con el resultado (recordatorio enviado/fallido) | Corrida real → tarjeta en el repo dueño del contacto | **Bajo observación de T-0339 con corridas reales programadas 25/09 y 26/09 08:30 ART — migrarlo antes del 26/09 08:30 ART podría confundir esa observación. Recomendado: esperar a después de esa fecha.** |

Registrar el router en Task Scheduler (cada 15 min) y cualquier corrida real de las tres
automatizaciones de arriba quedan fuera de esta entrega — son Fase B, dispatch separado.

### Fase B — el schtask del router YA está registrado (T-0598, 2026-09-24)

El plan de arriba (Fase A) decía "fuera de esta entrega" — ya no. `Wezbridge-AutomationRouter`
corre en vivo en este host desde antes de este fixup:

- **Cadencia:** cada 15 min, indefinido (`Repeat: Every: 0 Hour(s), 15 Minute(s)`, `Stop Task If
  Runs X Hours and X Mins: 72:00:00`). Verificado con `schtasks /query /tn
  Wezbridge-AutomationRouter /v /fo LIST`.
- **Launcher exacto** (`Task To Run` del schtask):
  `wscript.exe //B //NoLogo "C:\Users\pauol\scripts\run-hidden.vbs"
  C:\Users\pauol\scripts\hidden-tasks\Wezbridge-AutomationRouter.cmdline` — mismo patrón que el
  resto de las tareas ocultas de este host (VBS headless, sin ventana).
- **Qué corre el `.cmdline`:** su primera línea no-comentario (la única que `run-hidden.vbs`
  ejecuta) es literalmente
  `"G:\_OneDrive\OneDrive\Desktop\Py Apps\wezbridge\scripts\run-automation-router.cmd"` — sin
  argumentos.
- **`scripts/run-automation-router.cmd`** (ahora versionado en este repo, ver más abajo): cwd
  efectivo es `%~dp0..` = la raíz del repo `wezbridge` (el propio `.cmd` resuelve su directorio vía
  `%~dp0`, no depende del cwd con que Task Scheduler lo invoque). Comando exacto que corre:
  `node "%REPO%\scripts\automation-router.cjs" > "%FINDINGS%\router-run-latest.txt" 2>&1`, donde
  `%FINDINGS%` = `%REPO%\..\_intel\automation-findings` (mismo `_intel/` de todo este documento).
- **Logs / artefactos que deja cada corrida:**
  - `_intel/automation-findings/router-run.log` — append-only, una línea `[fecha hora] exit=<rc>`
    por corrida seguida del contenido completo de esa corrida (historial acumulado).
  - `_intel/automation-findings/router-run-latest.txt` — SOLO la corrida más reciente (se
    sobrescribe cada 15 min); leer este archivo primero para el estado actual.
  - `_intel/automation-findings/non-actionable.jsonl` — una línea por finding `actionable:false`
    procesado (ver contrato arriba).
  - `_intel/automation-findings/processed/` — findings ya entregados (`delivered:true` o
    `actionable:false`); nunca se borran, se mueven acá.
  - `_intel/automation-findings/quarantine/` — findings inválidos (JSON roto o campo requerido
    ausente); el router sigue con el resto, nunca crashea por uno malo.
- **Undo (si hay que sacarlo del scheduler):**
  1. `schtasks /delete /tn Wezbridge-AutomationRouter /f`
  2. Borrar `C:\Users\pauol\scripts\hidden-tasks\Wezbridge-AutomationRouter.cmdline`
  3. Los artefactos de `_intel/automation-findings/` (log, latest, non-actionable.jsonl,
     `.router-state.json`, `processed/`, `quarantine/`) son evidencia — no hace falta borrarlos
     para desactivar el router, solo dejan de crecer.

**Gap conocido (T-0600, no resuelto acá):** las notificaciones `actionable:true` necesitan una
identidad de sender explícita — `automation-router.cjs --from-pane <n>` (o
`WEZBRIDGE_AUTOMATION_FROM_PANE`) — porque una corrida programada no tiene pane WezTerm/Orca propio
del que `a2a_send` pueda inferir identidad por censo (ver "`--from-pane`" en el contrato de arriba).
Sin ese flag fijado, el `a2a_send` de una tarjeta nueva puede fallar con "no unambiguous
project/cwd target" — la tarjeta del ledger igual se crea (el router es idempotente por
`origin_key`), pero la entrega queda pendiente hasta el próximo tick. Rastreado como **T-0600**,
fuera de alcance de este fixup.

**DaemonSentinel migrado (Fase B-2, T-0598, este cambio):** `scripts/daemon-heartbeat-sentinel.cjs`
ahora emite un finding (`actionable:true`, `severity:high`, `repo_owner:"wezbridge"`) cuando el
daemon queda `down`/`wedged`/`http-unresponsive` por `DOWN_FINDING_THRESHOLD` (3) corridas
consecutivas del sentinel (~15 min a su cadencia de 5 min) — no en la primera corrida, para no
generar una tarjeta por un blip transitorio (la misma clase de falso-DOWN que T-0220 ya cubre para
el poke). El `fingerprint` es `daemon-outage-<episodeStartedAt>` (estable por outage, reusa el
mismo `episodeStartedAt` que ya trackea `evaluate()` para el poke/cooldown) — la misma interrupción
nunca produce dos findings. Una recuperación después de haber emitido un finding produce
opcionalmente uno `actionable:false` informativo. El estado de este umbral vive en su propio
archivo (`_intel/evidence/wezbridge/daemon-sentinel-finding-state.json`), separado del estado de
poke/episodio (`daemon-sentinel-state.json`) — la emisión de finding nunca puede alterar el
comportamiento de poke/deadman existente. Ver `evaluateFinding`/`emitDaemonFinding` en el propio
archivo para el detalle.

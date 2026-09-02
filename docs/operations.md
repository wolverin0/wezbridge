# Operations — env vars, restart, crash recovery, mux-wedge + GUI-hang triage (wezbridge)
> Qué cubre: variables de entorno útiles, el gotcha de rebind del daemon :4200, latitud WSL,
> recuperación de crash de wezterm, el triage mux-lento-vs-mux-wedgeado (firmas idénticas,
> remedios opuestos) y el tercer caso, GUI colgado con mux sano (2026-09-01): por qué
> `wezterm cli` sin `--no-auto-start` roba el socket del mux y cómo se recupera un GUI.
> Leer cuando: el daemon no rebindea, wezterm crasheó, todo ETIMEDOUTea, un GUI dice "not
> responding", hay >1 wezterm-mux-server, o vas a setear env de guards/grader/inbox.
> Términos clave: WEZBRIDGE_*, restore-session, probeMux, degraded, inconclusive,
> session-snapshot, --no-auto-start, gui-watchdog, Recover-WezTermGui, mux_split,
> espacio único de pane_id (--prefer-mux + sock, T-0260), WEZBRIDGE_PREFER_MUX=0, gui_only.

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
- `WEZBRIDGE_MAX_PANES` — tope de panes vivos del spawn path (default 5; `0`/`off` desactiva;
  seteado a 20 por el operador 2026-08-23)
- `WEZBRIDGE_AFFINITY=0` / `WEZBRIDGE_AFFINITY_JSON` — control de la afinidad proyecto→agente
  (default: lee `_intel/affinity.json`)

## Restart-on-port-conflict (daemon no rebindea a :4200)
Matar toda instancia stale:
```bash
for pid in $(wmic process where "Name='node.exe' and CommandLine like '%dashboard-server%'" get ProcessId /format:value 2>/dev/null | grep -oE "[0-9]+"); do taskkill //PID $pid //F; done
```

## Latitud WSL
El operador no usa WSL personalmente — los agentes tienen latitud completa para spawnear panes
WezTerm corriendo `wsl` para testing Linux-only (variantes de install de codex, paths POSIX)
sin preguntar. `spawn_session` + `wsl` como primer comando, o `agent: "shell"`.

## Crash de wezterm
No diagnostiques a mano — corré `npm run restore-session` (o decile al operador: `LEADER+R` /
CTRL+B,R picker). Los snapshots capturan cada 60s con retención de 24h mientras el daemon corre.
Pedido explícito del operador: todo restore pasa por la skill `wezterm-crash-recover`.

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

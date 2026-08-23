# Operations — env vars, restart, crash recovery, mux-wedge triage (wezbridge)
> Qué cubre: variables de entorno útiles, el gotcha de rebind del daemon :4200, latitud WSL,
> recuperación de crash de wezterm, y el triage completo mux-lento-vs-mux-wedgeado (firmas
> idénticas, remedios opuestos). Movido desde CLAUDE.md el 2026-08-23 (T-0213, regla <200).
> Leer cuando: el daemon no rebindea, wezterm crasheó, todo ETIMEDOUTea, o vas a setear
> env de guards/grader/inbox. Términos clave: WEZBRIDGE_*, restore-session, probeMux,
> classifyMuxProbe, degraded, inconclusive, session-snapshot.

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

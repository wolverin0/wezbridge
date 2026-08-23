# Repo layout + API HTTP del daemon (wezbridge)
> Qué cubre: el mapa de módulos de src/ (origen v3.3, mayormente vigente para los leafs),
> los agregados post-v3.3, y la lista de endpoints REST/SSE del daemon :4200 que consume el
> MCP server. Movido desde CLAUDE.md el 2026-08-23 (T-0213, regla <200 líneas).
> Leer cuando: busques dónde vive un módulo, o qué endpoint expone el daemon.
> Términos clave: mcp-server.cjs, dashboard-server, handlers/, a2a-intel, project-queue,
> lifecycle, action-log, /api/panes, /api/spawn, /api/events.

## Mapa de módulos (origen v3.3 — leafs mayormente vigentes; agregados posteriores anotados)
```
src/
  mcp-server.cjs           — MCP server, superficie de tools de wezbridge
  wezterm.cjs              — wrapper del wezterm cli, cache TTL
  pane-discovery.cjs       — estado de panes / persona / detección de Ctx%
  dashboard-server.cjs     — backend REST/SSE headless en :4200 (shim sobre
                             dashboard-server-routes.cjs + handlers/)
  telegram-streamer.cjs    — salida: output de panes → topic de Telegram
  tasks-watcher.cjs        — monitoreo de active_tasks.md
  task-parser.cjs          — extracción de tareas markdown
  status-parser.cjs        — clasificación de estado de panes
  safety-policy.cjs        — gate de acciones de 5 reglas (v3.2)
  sidecar-spawn.cjs        — spawner de panes de auditoría pareados (v3.2)
  a2a-heartbeat.cjs        — watcher de SLA de silencio de 5 min (v3.2)
  grades-registry.cjs      — LRU de outcome-grades + SSE (v3.2)
  team-manifest.cjs        — replay JSONL de teams + worktrees (v3.2)
  memory-inbox.cjs         — inbox gateado de MemoryMaster Dreams (v3.2)
  cost-meter.cjs           — tracker de runtime por pane (v3.2, solo lib)
  guard-bootstrap.cjs      — activación de PATH-shims (v3.2)
  permission-alerts.cjs, voice-handler.cjs, media-handler.cjs,
  ntfy-notifier.cjs, github-webhook.cjs, plugin-host.cjs,
  project-scanner.cjs, routines-config.cjs, diff-reporter.cjs
```
Post-v3.3: `session-snapshot.cjs` (crash-restore, ON por default desde v3.4.1),
`project-status-registry.cjs`, `telegram-router.cjs`, `handlers/`, `orchestrator-waker.cjs`,
`action-log.cjs` (2026-08-22), `a2a-intel.cjs`, `verified-send.cjs`, `daemon-status.cjs`,
`daemon-probe.cjs`, `pane-identity.cjs`, y el motor 2026-08-23: `project-queue.cjs` (colas
durables por proyecto) + `lifecycle.cjs` (tope/afinidad/auto-close-shadow).

Otros directorios: `test/` (suite; medición datada en CLAUDE.md), `bin/guard-shims/` (guards
argv de git/gh), `scripts/` (install-hooks, orchestrator-turn, queue-drain, daily-rollup,
sentinels, steward/gates), `docs/` (este mapa, a2a-protocol, operations, USAGE-guard, plugins,
SETUP-omniclaude-telegram, _drafts/), `plugins/example/`, `board-app/` (cockpit :4272).

## API endpoints del daemon :4200 (consumidos por el MCP server)
- `GET /api/panes` (alias `/api/sessions`) — lista de panes descubiertos
- `GET /api/sessions/:id/output?lines=N` — scrollback
- `POST /api/sessions/:id/prompt` — enviar texto
- `POST /api/sessions/:id/key` — enviar una tecla
- `POST /api/sessions/:id/kill` — matar pane
- `POST /api/sessions/:id/auto-handoff` — readiness-check v2.6 + handoff
- `POST /api/spawn` — nueva sesión Claude/Codex
- `POST /api/worktrees/:paneId/cleanup` y `/merge` — teardown de worktrees
- `GET /api/grades`, `POST /api/grade` — registro del outcome-grader v3.2
- `GET /api/events` — stream Server-Sent Events
- `GET /api/tasks` — estado de active_tasks.md
- `GET /api/health` — liveness por servicio (daemon-status; usado por sentinel y board)

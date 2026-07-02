# wezbridge (v3.4.3)

> **Status 2026-07-02 (v3.4.3):** focused MCP server, not the abandoned theorchestra orchestrator. Zero npm dependencies. 270 unit tests (all green). The browser dashboard, the orchestrator-worker pane, the React/Vite v3 build, and the orchestra-goose Tier-2 recipes were removed and preserved at the `omniclaude-pre-rollback` git tag (commit `acd3460`). **If you're a Claude Code session reading this, you are a regular dev session — there is no orchestrator-worker convention anymore.**

## What this repo is

An **MCP server** that exposes `mcp__wezbridge__*` tools so any Claude Code or Codex CLI session can spawn, prompt, read, and discover other sessions running in WezTerm panes. **The core MCP tools talk to the WezTerm CLI directly — they do NOT require the `:4200` daemon.** Only `auto_handoff` calls the daemon (`/api/panes/:id/auto-handoff`); every other tool works with the daemon down. The `:4200` HTTP daemon is a separate headless backend (SSE events, telegram-streamer, session-snapshot crash-restore, grades) — start it with `npm run dashboard` when you want those. Call `bridge_health` to see, in one shot, whether wezterm is reachable, the daemon is up, and the snapshot watcher is armed.
>
> **Security (v3.4.3):** the daemon binds `127.0.0.1` only. To expose it on a LAN set `WEZBRIDGE_BIND` (e.g. `0.0.0.0`) — a `WEZBRIDGE_API_TOKEN` then becomes mandatory or the daemon refuses to start.

## What this repo is NOT

- Not a browser dashboard (the v2.3-v3.1 dashboard UI was deprecated 2026-05-03 and removed in v3.2.1; see [`src/DEPRECATED.md`](src/DEPRECATED.md))
- Not an autonomous orchestrator (the orchestrator-worker pane / JSON-tick / vault-driven escalation system was reverted 2026-05-03)
- Not a hosted multi-agent platform
- Not a replacement for Claude Code / Codex / wezterm

## Repo layout (v3.4.x)

> The MCP server (`mcp-server.cjs`) and dashboard (`dashboard-server.cjs`, a thin shim over `dashboard-server-routes.cjs` + `handlers/`) were split into modules in the v3.4 refactor. Other post-v3.3 additions: `session-snapshot.cjs` (crash-restore, default ON since v3.4.1), `project-status-registry.cjs`, `telegram-router.cjs`, and the `handlers/` directory. Below is the original v3.3 map — mostly still accurate for the leaf modules.

```
src/
  mcp-server.cjs           — MCP server, tool surface for wezbridge
  wezterm.cjs              — wezterm cli wrapper, TTL-cached
  pane-discovery.cjs       — pane state / persona / Ctx% detection
  dashboard-server.cjs     — headless REST/SSE backend on :4200
  telegram-streamer.cjs    — outbound: pane output → Telegram topic
  tasks-watcher.cjs        — active_tasks.md monitoring
  task-parser.cjs          — markdown task extraction
  status-parser.cjs        — pane-state classification
  safety-policy.cjs        — 5-rule action gate (v3.2)
  sidecar-spawn.cjs        — paired audit-pane spawner (v3.2)
  a2a-heartbeat.cjs        — 5-min silence SLA watcher (v3.2)
  grades-registry.cjs      — outcome-grade LRU + SSE (v3.2)
  team-manifest.cjs        — JSONL replay of teams + worktrees (v3.2)
  memory-inbox.cjs         — gated MemoryMaster Dreams inbox (v3.2)
  cost-meter.cjs           — per-pane runtime tracker (v3.2, lib only)
  guard-bootstrap.cjs      — PATH-shim activation (v3.2)
  orchestrator-executor.cjs — preserved utility (legacy)
  permission-alerts.cjs, voice-handler.cjs, media-handler.cjs,
  ntfy-notifier.cjs, github-webhook.cjs, plugin-host.cjs,
  project-scanner.cjs, routines-config.cjs, diff-reporter.cjs
test/                       — unit-test files (270 cases, all green)
bin/guard-shims/            — git, gh argv-token guards (v3.2)
scripts/                    — install-hooks, command-guard, outcome-grader,
                             replay-merge, commit-guard, omniclaude-forever.sh,
                             start-telegram-streamer.cmd
docs/
  SETUP-omniclaude-telegram.md — the daily-driver walkthrough
  USAGE-guard.md               — v3.2 guard reference
  PLAN-managed-agents-backfill.md
  a2a-protocol.md              — A2A envelope spec
  plugins.md                   — plugin-host extension API
plugins/example/            — plugin-host demo
package.json                — name "wezbridge", zero deps
```

## Running it

The core MCP tools (discover/read/send/spawn/kill/…) drive the WezTerm CLI directly and work with **no daemon running**. The `:4200` daemon is only needed for `auto_handoff` and the background services (SSE, telegram-streamer, session-snapshot crash-restore, grades).

```bash
npm run dashboard          # start the :4200 daemon (binds 127.0.0.1)
npm run dev                # node --watch — auto-restart on file change
```

`http://127.0.0.1:4200/` returns 404 — that's intentional. The daemon is headless. Verify it's up with `curl http://127.0.0.1:4200/api/panes`, or from any session call the `bridge_health` MCP tool. It binds loopback only; set `WEZBRIDGE_BIND=0.0.0.0` (plus a `WEZBRIDGE_API_TOKEN`) to expose it on a LAN.

For the OmniClaude-via-Telegram pattern (one Claude Code pane controls the swarm via DMs), see [`docs/SETUP-omniclaude-telegram.md`](docs/SETUP-omniclaude-telegram.md).

## Useful environment variables

- `WEZTERM_LOG=wezterm_mux_server_impl::local=off` — silences WezTerm's 10054 mux-disconnect error category on Windows
- `DASHBOARD_PORT` — override `:4200`
- `WEZBRIDGE_GUARD_SHIMS=1` — activate PATH-based command guard (requires `bin/guard-shims/` on PATH)
- `WEZBRIDGE_GUARD_OVERRIDE`, `WEZBRIDGE_SAFETY_OVERRIDE`, `WEZBRIDGE_PREPUSH_OVERRIDE` — bypass-once for the v3.2 guards
- `WEZBRIDGE_MM_INBOX=1` — turn on memory-inbox writes
- `WEZBRIDGE_GRADER_BACKEND=stub|claude|codex` — pick outcome-grader backend

Restart-on-port-conflict gotcha: if the daemon won't rebind to `:4200`, find every stale instance with:

```bash
for pid in $(wmic process where "Name='node.exe' and CommandLine like '%dashboard-server%'" get ProcessId /format:value 2>/dev/null | grep -oE "[0-9]+"); do taskkill //PID $pid //F; done
```

## API endpoints (consumed by the MCP server)

- `GET /api/panes` (alias `/api/sessions`) — list discovered panes
- `GET /api/sessions/:id/output?lines=N` — scrollback
- `POST /api/sessions/:id/prompt` — send text
- `POST /api/sessions/:id/key` — send single key
- `POST /api/sessions/:id/kill` — kill pane
- `POST /api/sessions/:id/auto-handoff` — trigger v2.6 readiness-check + handoff
- `POST /api/spawn` — new Claude/Codex session
- `POST /api/worktrees/:paneId/cleanup` and `/merge` — worktree teardown
- `GET /api/grades`, `POST /api/grade` — v3.2 outcome-grader registry
- `GET /api/events` — Server-Sent Events stream
- `GET /api/tasks` — active_tasks.md state

## A2A protocol (when peer panes coordinate)

Every peer-to-peer message uses an envelope:

```
[A2A from pane-<N> to pane-<M> | corr=<id> | type=request|ack|progress|result|error]
<body>
```

Hard rules (mandatory for any pane using these tools):

1. Always follow `send_prompt` with `send_key("enter")`.
2. Never send bash via `send_prompt` into a running TUI — your text becomes a user prompt, not a shell command.
3. Every responder MUST push `type=progress` every ~3 min during long work and `type=result` on completion. Codex cannot subscribe via `Monitor`; Claude can.
4. Before spawning a peer, declare your coordinator role: `parallel-worker` / `qa-verifier` / `pre-stager` / `monitor-only`.

Full spec: [`docs/a2a-protocol.md`](docs/a2a-protocol.md).

## Reviving the abandoned ambition

If you want to bring back the dashboard UI, the orchestrator-worker pane, the orchestra-goose Tier-2 recipes, the React/Vite v3 build, or any of the historical "theorchestra" surface: `git checkout omniclaude-pre-rollback`. That tag (commit `acd3460`) is the frozen pre-revert state with everything intact. It is preserved on both `wolverin0/wezbridge` and `wolverin0/theorchestra` (archived).

## Tests

```bash
node --test --test-reporter=spec test/*.test.cjs
```

270 cases, all green at v3.4.3.

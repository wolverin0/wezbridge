# DEPRECATED — dashboard UI (2026-04-30) + dead paths (2026-08-20)

> Covers: what in `src/` is deprecated vs active. Dashboard UI = vaporware (2026-04-30);
> daemon + MCP server = ACTIVE. Dead paths (2026-08-20): `tasks-watcher.cjs` (zero require
> sites), the omni-watcher gap (module removed, call sites survive), `clawtrol-bridge.cjs`
> (buried by decision record `_intel/clawtrol-bridge.json`, T-0191 cancelled). Read when:
> deciding whether a `src/` module is safe to build on or delete.

## theorchestra v3 dashboard UI — DEPRECATED 2026-04-30 / scope clarified 2026-05-03

## What IS deprecated (the UI only)

- `src/dashboard.html` — single-file vanilla-JS frontend (FuturaOS look). Was vaporware: backend `/api/panes/:id/queue` and `/api/panes/:id/inject-context` ship as explicit noops; UI buttons are fakes. Don't develop new features here; don't open it in a browser expecting it to work.

## What is NOT deprecated (the daemon + MCP server are ACTIVE on 2.7.0)

The dashboard *daemon* (`src/dashboard-server.cjs` on port 4200) stays running because it BACKS the wezbridge MCP server. **You need it up.** Start it via `npm run dashboard` or `npm run dev`.

These files remain core to the 2.7.0 control surface:

- `dashboard-server.cjs` — REST/SSE backend the wezbridge MCP server fetches against (`/api/panes`, `/api/tasks`, `/api/events`). REQUIRED for `mcp__wezbridge__discover_sessions` etc.
- `mcp-server.cjs` — wezbridge MCP tools (spawn_session, send_prompt, send_key, read_output, discover_sessions). Primary control surface.
- `wezterm.cjs`, `pane-discovery.cjs`, `task-parser.cjs`, `status-parser.cjs` — utility libraries the MCP server uses.
- `telegram-streamer.cjs` — Telegram remote-control channel.

## Dead paths (2026-08-20 — listed here; actual deletion is a future commit)

- `tasks-watcher.cjs` — nothing requires it anymore (verified by grep 2026-08-20: zero
  require sites outside the file itself). It watched `active_tasks.md`, a convention the
  fleet ledger (`_docs-curation` + `_intel`) replaced. Do not build on it.
- **The omni-watcher gap** — `omni-watcher.cjs` itself was removed in the v3.x rollback,
  but call sites survived it: `handlers/event-handlers.cjs` (SSE spawns the watcher child
  if the file exists; since 2026-08-03 it degrades to a plain SSE stream when absent) and
  `plugin-host.cjs` (`WATCHER_PATH` points at the missing file, so the plugin runtime is
  inert). `docs/a2a-protocol.md` and `docs/plugins.md` still describe the removed watcher.
  Treat every reference to `omni-watcher.cjs` as dead; removing the surviving call sites
  is part of the same future deletion commit.
- `clawtrol-bridge.cjs` — CODE PRESERVED, loop buried. ClawTrol was retired by operator
  ruling 2026-08-13 (274 consecutive sync failures / 404; T-0191 closed as cancelled
  2026-08-20). The bridge refuses to arm while the decision record
  `_intel/clawtrol-bridge.json` (`_disarmed_*` key) exists — even with CLAWTROL_URL/TOKEN
  set. Re-arm only if a cockpit exists again and the operator says so.

## What changed 2026-05-03

After dispatching todomax W2-W11 autonomously via the orchestra-goose Tier-2 recipe, user decided the trade (lose tight-loop control + Telegram presence for fire-and-forget autonomy that wasn't actually needed) was the wrong direction. Reverted to 2.7.0 daily-driver pattern.

orchestra-goose recipes (`tier2-build-wave.yaml`, `tier2-plan-and-build.yaml`) sit in cold storage at `Py Apps/orchestra-goose/recipes/` — invoke ONLY for genuine fire-and-forget multi-wave runs. Day-to-day work uses Claude Code as orchestrator + wezbridge MCP for control + Telegram for remote presence.

## History

The 2026-04-30 P0 deprecation banner was overzealous: it conflated the dashboard UI (genuinely vaporware) with the daemon (genuinely needed). Original commit `acd3460` was the deprecation; this re-scoping is part of the 2026-05-03 revert.

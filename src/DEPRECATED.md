# theorchestra v3 dashboard UI — DEPRECATED 2026-04-30 / scope clarified 2026-05-03

## What IS deprecated (the UI only)

- `src/dashboard.html` — single-file vanilla-JS frontend (FuturaOS look). Was vaporware: backend `/api/panes/:id/queue` and `/api/panes/:id/inject-context` ship as explicit noops; UI buttons are fakes. Don't develop new features here; don't open it in a browser expecting it to work.

## What is NOT deprecated (the daemon + MCP server are ACTIVE on 2.7.0)

The dashboard *daemon* (`src/dashboard-server.cjs` on port 4200) stays running because it BACKS the wezbridge MCP server. **You need it up.** Start it via `npm run dashboard` or `npm run dev`.

These files remain core to the 2.7.0 control surface:

- `dashboard-server.cjs` — REST/SSE backend the wezbridge MCP server fetches against (`/api/panes`, `/api/tasks`, `/api/events`). REQUIRED for `mcp__wezbridge__discover_sessions` etc.
- `mcp-server.cjs` — wezbridge MCP tools (spawn_session, send_prompt, send_key, read_output, discover_sessions). Primary control surface.
- `wezterm.cjs`, `pane-discovery.cjs`, `task-parser.cjs`, `status-parser.cjs` — utility libraries the MCP server uses.
- `tasks-watcher.cjs` — active_tasks.md parsing.
- `telegram-streamer.cjs` — Telegram remote-control channel.

## What changed 2026-05-03

After dispatching todomax W2-W11 autonomously via the orchestra-goose Tier-2 recipe, user decided the trade (lose tight-loop control + Telegram presence for fire-and-forget autonomy that wasn't actually needed) was the wrong direction. Reverted to 2.7.0 daily-driver pattern.

orchestra-goose recipes (`tier2-build-wave.yaml`, `tier2-plan-and-build.yaml`) sit in cold storage at `Py Apps/orchestra-goose/recipes/` — invoke ONLY for genuine fire-and-forget multi-wave runs. Day-to-day work uses Claude Code as orchestrator + wezbridge MCP for control + Telegram for remote presence.

## History

The 2026-04-30 P0 deprecation banner was overzealous: it conflated the dashboard UI (genuinely vaporware) with the daemon (genuinely needed). Original commit `acd3460` was the deprecation; this re-scoping is part of the 2026-05-03 revert.

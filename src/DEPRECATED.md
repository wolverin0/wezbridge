# theorchestra v3 dashboard — DEPRECATED 2026-04-30

**Status:** archived per debate 002 (`wezbridge/debates/002-orchestrator-cycle-stop/synthesis.md`).

## What's deprecated

The v3 dashboard daemon and its orchestrator pattern. Specifically the files in this directory that implement the dashboard / orchestrator-worker pattern:

- `dashboard-server.cjs` — port-4200 HTTP/SSE server
- `dashboard.html` — single-file vanilla-JS frontend (FuturaOS look, v2.4 features)
- `orchestrator-executor.cjs` — action classifier and dispatcher
- `permission-alerts.cjs`, `tasks-watcher.cjs`, `pane-discovery.cjs` (when used in the dashboard daemon's polling loop)

## Why deprecated

theorchestra v3 was iteration 2 of 3 failed attempts at an "omni orchestrator" for multi-project AI dev orchestration. The backend's `/api/panes/:id/queue` and `/api/panes/:id/inject-context` ship as explicit noops; UI buttons are fakes. See debate 002 for the full failure pattern across omniclaude → theorchestra v3 → orchestra-goose Wave 5.

## What's NOT deprecated

These files in `src/` remain active:

- `mcp-server.cjs` — wezbridge MCP tools (spawn_session, send_prompt, send_key, read_output, discover_sessions). Still supported. Used by orchestra-goose's `wezbridge-compat/` shim.
- `wezterm.cjs`, `pane-discovery.cjs`, `task-parser.cjs`, `status-parser.cjs` (when used outside the dashboard) — utility libraries for the MCP server.
- `tasks-watcher.cjs` — read-only active_tasks.md parsing; still used by orchestra-goose recipes.
- `telegram-streamer.cjs` — escalation channel. Wrapped by orchestra-goose `recipes/escalate-telegram.yaml`.

## Replacement

orchestra-goose at `Py Apps/orchestra-goose/` (Goose fork). Currently at `pre-stop-cycle-2026-04-30` tag with Wave 5 BLOCKED. Path forward: P3 (integration test) → P1 (peer-pane recipe via `wezterm cli spawn`, NOT goose summon Task tool).

## Restoration

If the orchestra-goose migration fails (Spike A + Spike B both fail to falsify the failure mode), this dashboard can be restored as a fallback by removing this DEPRECATED.md file and starting `node src/dashboard-server.cjs` on port 4200. No code was moved or deleted in P0 — files stay where they were for reversibility.

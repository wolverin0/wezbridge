# Plan — wezbridge review remediation (2026-07-02)

Source: `artifacts/2026-07-02-wezbridge-review.html`. Branch: `fix/review-2026-07-02`.

## Scope split

**Execute + test this pass** (unit-testable / no live-pane intrusion, reversible):

| # | Item | Files | Verify |
|---|------|-------|--------|
| 1 | **SECURITY**: bind `127.0.0.1` by default; `WEZBRIDGE_BIND` env for wider bind; require `WEZBRIDGE_API_TOKEN` whenever bind ≠ loopback | `src/dashboard-server-routes.cjs` | new test: default listen host is loopback; abort when bind wide + no token |
| 2 | **`bridge_health` MCP tool**: wezterm reachable, daemon up/down+version, snapshot armed, pane count — one-call self-diagnosis | `src/mcp-server.cjs` | unit test: tool listed + returns shape; graceful when daemon down |
| 3 | **`spawn_session` `model` param**: append `--model <m>` to argv (closes tiering gap; additive, no default change) | `src/mcp-server.cjs` | unit test on argv build |
| 4 | **CLAUDE.md rewrite**: v3.4.2, 263 tests, correct layout, fix false "daemon required for MCP tools" claim | `CLAUDE.md` | read-back; grep for stale `3.3.0`/`184` |
| 5 | **TS orphans**: preserve on `experiment/peers-broker` branch (non-destructive) instead of leaving uncommitted | `src/backend/*.ts`, `src/frontend/*`, `src/mcp/handlers/peers.ts` | branch exists + files committed there |

**Deferred to a follow-up** (touch the live-pane hot path or change behavior — need live-wezterm iteration, would intrude on running sessions):

- **enter-verify + retry in `send_prompt`** (the claim-8945 killer). Note: `wez.sendText` already appends `\r`, and the handler also sends a second `\r` via `sendTextNoEnter` — so Enter is already sent twice today. A real fix reads the pane tail to confirm submission before returning; that requires spawning a live pane to prove. Ticket it, don't ship blind.
- **async-sleep refactor** of `spawn_session`/`wait_for_idle` (remove `execFileSync` sleeps that block the stdio loop). Correctness-sensitive; verify with a live spawn.
- **`--continue` → fresh-start default** flip (behavior change).
- **`agent` param** (spawn Codex panes), **`a2a_send`** tool, **`read_output` delta/cursor** mode — larger features.
- Sentinel autostart in `npm run setup`; archive `orchestrator-executor.cjs`; `docs/_drafts` sweep; re-run graphify.

## Exit criteria
- `node --test test/*.test.cjs` stays green (was 263/263) and adds coverage for items 1-3.
- CLAUDE.md contains no `3.3.0` / `184 tests` / "daemon must be alive for the MCP server's tools to work".
- `experiment/peers-broker` branch holds the TS files; working tree no longer shows them untracked.

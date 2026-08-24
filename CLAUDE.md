# wezbridge (v3.5.0)

> **Status 2026-07-02 (v3.5.0):** focused MCP server, not the abandoned theorchestra orchestrator. Zero npm dependencies. The browser dashboard, the orchestrator-worker pane, the React/Vite v3 build, and the orchestra-goose Tier-2 recipes were removed and preserved at the `omniclaude-pre-rollback` git tag (commit `acd3460`). **If you're a Claude Code session reading this, you are a regular dev session — there is no orchestrator-worker convention anymore.**
>
> **v3.5.0 highlights:** `send_prompt`/`a2a_send` now VERIFY submission (read the input box back, retry enter, return `submitted`) — the manual follow-up `send_key("enter")` rule is obsolete on v3.5+ servers. `spawn_session` starts FRESH sessions by default (`continue: true` to opt back into `--continue`), and gains `agent: claude|codex|shell` + `model`. `read_output` gains delta/cursor polling. `wait_for_idle`/`spawn_session` no longer block the MCP event loop.

## What this repo is

An **MCP server** that exposes `mcp__wezbridge__*` tools so any Claude Code or Codex CLI session can spawn, prompt, read, and discover other sessions running in WezTerm panes. **The core MCP tools talk to the WezTerm CLI directly — they do NOT require the `:4200` daemon.** Only `auto_handoff` calls the daemon (`/api/panes/:id/auto-handoff`); every other tool works with the daemon down. The `:4200` HTTP daemon is a separate headless backend (SSE events, telegram-streamer, session-snapshot crash-restore, grades) — start it with `npm run dashboard` when you want those. Call `bridge_health` to see, in one shot, whether wezterm is reachable, the daemon is up, and the snapshot watcher is armed.
>
> **Security (v3.4.3):** the daemon binds `127.0.0.1` only. To expose it on a LAN set `WEZBRIDGE_BIND` (e.g. `0.0.0.0`) — a `WEZBRIDGE_API_TOKEN` then becomes mandatory or the daemon refuses to start.

## What this repo is NOT

- Not a browser dashboard (the v2.3-v3.1 dashboard UI was deprecated 2026-05-03 and removed in v3.2.1; see [`src/DEPRECATED.md`](src/DEPRECATED.md))
- Not an autonomous orchestrator (the orchestrator-worker pane / JSON-tick / vault-driven escalation system was reverted 2026-05-03)
- Not a hosted multi-agent platform
- Not a replacement for Claude Code / Codex / wezterm

## Repo layout

Mapa de módulos de `src/` + agregados post-v3.3 + endpoints del daemon: **[`docs/repo-layout.md`](docs/repo-layout.md)**.
Lo esencial: `mcp-server.cjs` (tools MCP) · `wezterm.cjs` (CLI wrapper) · `dashboard-server.cjs` (daemon :4200) ·
motor 2026-08-23: `project-queue.cjs`, `lifecycle.cjs`, `action-log.cjs`, `orchestrator-waker.cjs`.

## Running it

The core MCP tools (discover/read/send/spawn/kill/…) drive the WezTerm CLI directly and work with **no daemon running**. The `:4200` daemon is only needed for `auto_handoff` and the background services (SSE, telegram-streamer, session-snapshot crash-restore, grades).

```bash
npm run dashboard          # start the :4200 daemon (binds 127.0.0.1)
npm run dev                # node --watch — auto-restart on file change
```

`http://127.0.0.1:4200/` returns 404 — that's intentional. The daemon is headless. Verify it's up with `curl http://127.0.0.1:4200/api/panes`, or from any session call the `bridge_health` MCP tool. It binds loopback only; set `WEZBRIDGE_BIND=0.0.0.0` (plus a `WEZBRIDGE_API_TOKEN`) to expose it on a LAN.

For the OmniClaude-via-Telegram pattern (one Claude Code pane controls the swarm via DMs), see [`docs/SETUP-omniclaude-telegram.md`](docs/SETUP-omniclaude-telegram.md).

## Operations (env vars, restarts, crash, mux-wedge)

Todo el detalle operativo vive en **[`docs/operations.md`](docs/operations.md)**: variables
`WEZBRIDGE_*` (guards, grader, tope de panes, afinidad), el gotcha de rebind del `:4200`,
latitud WSL, y el triage completo **mux-lento-vs-wedgeado** (firmas idénticas, remedios
opuestos — LEELO ANTES de reiniciar WezTerm). Crash de wezterm → `npm run restore-session`
vía la skill `wezterm-crash-recover`, nunca a mano.

## A2A protocol (when peer panes coordinate)

Every peer-to-peer message uses an envelope:

```
[A2A from pane-<N> to pane-<M> | corr=<id> | type=request|ack|progress|result|error]
<body>
```

Hard rules (mandatory for any pane using these tools):

1. Prefer `a2a_send` — it builds the envelope, sends it, and VERIFIES submission in one call. When using raw `send_prompt` (v3.5+), check the returned `submitted` field: only send `send_key("enter")` if it reports `stuck`. (Pre-v3.5 servers verify nothing — there, always follow `send_prompt` with `send_key("enter")`.)
2. Never send bash via `send_prompt` into a running TUI — your text becomes a user prompt, not a shell command. (`spawn_session` with `agent: "shell"` gives you a real shell pane.)
3. Every responder MUST push `type=progress` every ~3 min during long work and `type=result` on completion. Codex cannot subscribe via `Monitor`; Claude can — Codex requesters should poll with `read_output` delta mode (`with_cursor` → `since`).
4. Before spawning a peer, declare your coordinator role: `parallel-worker` / `qa-verifier` / `pre-stager` / `monitor-only`. Note: `spawn_session` starts FRESH sessions by default since v3.5 (pass `continue: true` for the old `--continue` behavior).

Full spec: [`docs/a2a-protocol.md`](docs/a2a-protocol.md).

## Reviving the abandoned ambition

If you want to bring back the dashboard UI, the orchestrator-worker pane, the orchestra-goose Tier-2 recipes, the React/Vite v3 build, or any of the historical "theorchestra" surface: `git checkout omniclaude-pre-rollback`. That tag (commit `acd3460`) is the frozen pre-revert state with everything intact. It is preserved on both `wolverin0/wezbridge` and `wolverin0/theorchestra` (archived).

## Tests

```bash
node --test --test-reporter=spec test/*.test.cjs
```

**~917 pass, 1 fail ambiental, 1 skipped — medido 2026-08-24** (el fail es
`lifecycle.test` que exige un pane-id real vivo, tarjeteado T-0239; crecieron 5 suites
nuevas el 24-ago: sentinel/identidad/restore/rescue/dispatch-gate).
Re-medí antes de citar este número; un conteo sin fecha de medición envejece a mentira.

## Docs map

Doc triage map at `DOCS-MAP.md` (project root): every doc's verdict (CURRENT / SUPERSEDED / ABANDONED / GENERATED) and what replaced what. CURRENT docs carry a greppable 7-line header — grep heads before reading bodies; never base work on a doc the map marks superseded.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **wezbridge** (36534 symbols, 91091 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## When Debugging

1. `gitnexus_query({query: "<error or symptom>"})` — find execution flows related to the issue
2. `gitnexus_context({name: "<suspect function>"})` — see all callers, callees, and process participation
3. `READ gitnexus://repo/wezbridge/process/{processName}` — trace the full execution flow step by step
4. For regressions: `gitnexus_detect_changes({scope: "compare", base_ref: "main"})` — see what your branch changed

## When Refactoring

- **Renaming**: MUST use `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` first. Review the preview — graph edits are safe, text_search edits need manual review. Then run with `dry_run: false`.
- **Extracting/Splitting**: MUST run `gitnexus_context({name: "target"})` to see all incoming/outgoing refs, then `gitnexus_impact({target: "target", direction: "upstream"})` to find all external callers before moving code.
- After any refactor: run `gitnexus_detect_changes({scope: "all"})` to verify only expected files changed.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Tools Quick Reference

| Tool | When to use | Command |
|------|-------------|---------|
| `query` | Find code by concept | `gitnexus_query({query: "auth validation"})` |
| `context` | 360-degree view of one symbol | `gitnexus_context({name: "validateUser"})` |
| `impact` | Blast radius before editing | `gitnexus_impact({target: "X", direction: "upstream"})` |
| `detect_changes` | Pre-commit scope check | `gitnexus_detect_changes({scope: "staged"})` |
| `rename` | Safe multi-file rename | `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` |
| `cypher` | Custom graph queries | `gitnexus_cypher({query: "MATCH ..."})` |

## Impact Risk Levels

| Depth | Meaning | Action |
|-------|---------|--------|
| d=1 | WILL BREAK — direct callers/importers | MUST update these |
| d=2 | LIKELY AFFECTED — indirect deps | Should test |
| d=3 | MAY NEED TESTING — transitive | Test if critical path |

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/wezbridge/context` | Codebase overview, check index freshness |
| `gitnexus://repo/wezbridge/clusters` | All functional areas |
| `gitnexus://repo/wezbridge/processes` | All execution flows |
| `gitnexus://repo/wezbridge/process/{name}` | Step-by-step execution trace |

## Self-Check Before Finishing

Before completing any code modification task, verify:
1. `gitnexus_impact` was run for all modified symbols
2. No HIGH/CRITICAL risk warnings were ignored
3. `gitnexus_detect_changes()` confirms changes match expected scope
4. All d=1 (WILL BREAK) dependents were updated

## Keeping the Index Fresh

After committing code changes, the GitNexus index becomes stale. Re-run analyze to update it:

```bash
npx gitnexus analyze
```

If the index previously included embeddings, preserve them by adding `--embeddings`:

```bash
npx gitnexus analyze --embeddings
```

To check whether embeddings exist, inspect `.gitnexus/meta.json` — the `stats.embeddings` field shows the count (0 means no embeddings). **Running analyze without `--embeddings` will delete any previously generated embeddings.**

> Claude Code users: A PostToolUse hook DETECTS staleness after `git commit`/`git merge` and reminds you to re-run analyze — it does NOT reindex automatically (by design, to avoid blocking your commit). Run `npx gitnexus analyze --embeddings` yourself when the reminder fires.

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->

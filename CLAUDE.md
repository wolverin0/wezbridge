# theorchestra / wezbridge (v2.7.0)

> **STATUS 2026-05-03:** orchestra-goose Tier-2 architecture experiment (April 30 / May 3) reverted by user decision — operator-control regression outweighed autonomy gains. Back on the proven 2.7.0 control surface: Claude Code as orchestrator + wezbridge MCP (spawn/send/read/discover) + Telegram. The dashboard UI (`src/dashboard.html` + dashboard-server's HTML routes) remains archived per `src/DEPRECATED.md` — it was vaporware. The dashboard *daemon* itself (`src/dashboard-server.cjs` on :4200) stays alive because it backs the wezbridge MCP server. Start with `npm run dashboard` or `npm run dev`.

A proactive orchestrator for multiple Claude Code + Codex sessions running in WezTerm panes. Now with **Agency Mode**: spawn persona-specialized Claude agents that coordinate via A2A.

## What this is (current shipping surface)

**Dashboard** — `src/dashboard-server.cjs` runs on port 4200 and serves `src/dashboard.html` (single-file vanilla-JS HTML, v3.1 FuturaOS look, v2.4 features on top). The HTML is the canonical frontend; the React folder at `tmp/dashboard-react-v2.1/` is archived legacy.

**Agency Mode (v2.5)** — spawn Claude sessions with domain-specific personas from `~/.claude/agents/` (95+ available). `POST /api/spawn {cwd, persona: "reviewer", permission_mode: "plan"}` creates a fresh session with the persona's system prompt appended. The MCP tool `spawn_session` supports the same params. `GET /api/personas` lists available personas. Pane discovery detects persona from tab title `[persona-name]`.

The dashboard has 4 tabs (Sessions, Live, Desktop, Spawn), a right activity sidebar with 3 collapsible + reorderable panels (OmniClaude monitor, A2A activity, compact Events), and a bottom Active Tasks strip. See v2.3 plan: `docs/PLAN-dashboard-v2.3.md`.

**Orchestrator daemon** (optional, separate process) — `src/orchestrator.cjs` polls panes + vault + writes decisions to the dashboard. Continues to work as documented below.

**Key non-obvious features**
- **A2A handoff push** (v2.3.1): click `↗ Handoff` on any pane card, pick a target, type an instruction. The backend sends an instructive prompt to the SOURCE pane (not target). That Claude then authors its own handoff file in `<source-cwd>/handoffs/handoff-to-<target>-<ts>-<uuid>.md` and contacts the target via wezbridge MCP `send_prompt + send_key('enter')`. Pattern: **delegation, not injection**. See claim 9443.
- **A2A pending state** (`GET /api/a2a/pending`): module-scoped Map, accumulates only while at least one SSE client is connected — by design (claim 9440). LRU 500 + 24h TTL.
- **Translation layer** in the SSE handler maps `omni-watcher` events (`ts`, `event`, `details`) to the HTML's expected shape (`timestamp`, `type`, `output`). Adding new watcher events requires also adding them to the `typeMap` in `src/dashboard-server.cjs`.

**Key docs**
- `docs/PLAN-OF-TRUTH.md` — **authoritative v3.0 plan.** Older plans archived under `docs/_archive/`.
- `docs/a2a-protocol.md` — A2A envelope format
- `vault/_roadmap.md` — live, orchestrator-consumed roadmap

**Gate command:** `npm run v3:gate` runs the full PLAN-OF-TRUTH aggregator
(baseline + advisor + dashboard-action + reasoning-panel). Must be green
before any release cut.

**Autonomous orchestration (v3.0):** the v3 orchestrator supports an optional
LLM advisor that adjudicates content-class decisions (escalations) before
they hit the user. Enable with `THEORCHESTRA_LLM_ADVISOR=1` — provider
auto-picks Anthropic API (if `ANTHROPIC_API_KEY` set) else the Claude CLI
on PATH. Advisor-attested `dashboard_action`s (click/hover/focus/dblclick)
fire as mechanics via agent-browser without user confirm. Per-pane cooldown
30s, per-hour cap 60 calls, per-(verb,ref) UI cooldown 10s.

## How the orchestrator works

The orchestrator is **NOT a Claude Code session you interact with directly**. It is a Node.js daemon that:

1. **Auto-spawns a hidden worker pane** in `vault/_orchestrator-worker/`. The worker is a Claude Code session loaded with a strict CLAUDE.md (`vault/_orchestrator-worker/CLAUDE.md`) that enforces JSON-only output.

2. **Every tick** (default 3 min), the daemon:
   - Gathers state (live panes, vault notes, roadmap, priorities, recent decisions, pending escalations)
   - Writes the state to `vault/_orchestrator-worker/.state.json`
   - Sends a short directive to the worker: `TICK — Read .state.json, then Write .response.json with your action array`
   - Polls the filesystem for `.response.json`
   - Parses + validates the JSON action list
   - Dispatches actions through the executor

3. **Event-driven hooks** also call the worker on:
   - `COMPLETED` — a session finished a task
   - `PERMISSION` — a session needs a permission decision
   - `STUCK` — a session has been "working" with no output change for >10min

4. **Action types** the worker can return:
   - `wait` — do nothing, the session is mid-task or blocked
   - `continue` — send a follow-up prompt to the session
   - `review` — spawn a fresh Claude Code session to audit recent work
   - `escalate` — surface a decision to the human via the dashboard UI
   - `kill` — terminate a stuck or redundant session

5. **Hybrid autonomy**: safe actions (`wait`, safe `continue`) auto-execute. Risky actions (`review`, `kill`, destructive `continue`, `escalate`) become escalations in the UI.

## Vault structure

| Path | Purpose | Writer |
|------|---------|--------|
| `vault/_index.md` | Auto-generated session table | server (every event) |
| `vault/_roadmap.md` | What we're working toward | human (via UI) |
| `vault/_priorities.md` | Current focus ranking | human (via UI) |
| `vault/_orchestrator-config.md` | Per-project trust + tool allowlists | human |
| `vault/_orchestrator-worker/CLAUDE.md` | Worker contract (JSON I/O rules) | dev |
| `vault/_orchestrator-worker/.state.json` | Per-tick state snapshot | daemon |
| `vault/_orchestrator-worker/.response.json` | Per-tick worker response | worker |
| `vault/_orchestrator/decisions-YYYY-MM-DD.md` | Audit log of every decision | daemon |
| `vault/_escalations/<id>.md` | One file per escalation | daemon (resolved by user via UI) |
| `vault/sessions/<project>.md` | Per-project history + frontmatter | server |
| `vault/_daily/<date>.md` | Today's event log | server |

## Running the dashboard

```bash
# v2.3 HTML dashboard (canonical) on :4200
DASHBOARD_PORT=4200 node src/dashboard-server.cjs

# or via npm (if the script is still wired to this server):
npm run dashboard    # plain run + auto-open browser
npm run dev          # node --watch — auto-restart on file change
```

**Restart gotcha** (claim 9428): when you `kill <pid>` the dashboard and it won't rebind to :4200, enumerate and kill ALL stale instances first:
```bash
for pid in $(wmic process where "Name='node.exe' and CommandLine like '%dashboard-server%'" get ProcessId /format:value 2>/dev/null | grep -oE "[0-9]+"); do taskkill //PID $pid //F; done
```

Environment variables:
- `ORCHESTRATOR_TICK_MS` — tick interval (default 180000 = 3 min)
- `ORCHESTRATOR_DRY_RUN=1` — log actions but don't execute
- `STUCK_THRESHOLD_MS` — how long a working pane can sit unchanged before being flagged stuck (default 600000 = 10 min)
- `VAULT_PATH` — override vault directory location

## API endpoints

Sessions (manual control):
- `GET /api/sessions` — list panes (worker pane filtered out)
- `GET /api/sessions/:id/output` — raw terminal output
- `GET /api/sessions/:id/chat` — parsed chat messages
- `POST /api/sessions/:id/prompt` — send text
- `POST /api/sessions/:id/key` — send special key (1/2/3/enter/ctrl+c)
- `POST /api/sessions/:id/kill` — kill pane
- `POST /api/spawn` — spawn new Claude session

Orchestrator:
- `GET /api/orchestrator/state` — paused, dry_run, worker pane, decisions, escalations
- `GET /api/orchestrator/decisions?limit=N` — recent decisions
- `GET /api/orchestrator/escalations?status=pending` — escalations
- `POST /api/orchestrator/escalations/:id/resolve` — `{action: 'approve' | 'reject' | 'custom', payload}`
- `POST /api/orchestrator/tick` — manual tick
- `POST /api/orchestrator/pause` / `resume`
- `POST /api/orchestrator/worker/restart` — recycle worker
- `GET / PUT /api/orchestrator/roadmap`
- `GET / PUT /api/orchestrator/priorities`

Vault:
- `GET /api/projects` — known projects on disk
- `GET /api/events` — Server-Sent Events stream

## Safety rails (cannot be disabled)

1. **Hybrid classifier** — every action passes through `src/orchestrator-executor.cjs` `classifyAction()`
2. **Cooldown** — max 1 auto-`continue` per session per 90 seconds
3. **Loop detection** — same action on same session 3x in 5 min → pause daemon + escalate
4. **Destructive keyword scan** — `rm -rf`, `drop`, `push`, `deploy`, `migrate` → escalate
5. **Per-project denylist** — `vault/_orchestrator-config.md` "Never-Auto Projects" always escalate
6. **No self-actions** — executor refuses any action targeting the worker pane or wezbridge itself
7. **Dry-run** — `ORCHESTRATOR_DRY_RUN=1` logs without executing
8. **Pause switch** — UI button or `POST /api/orchestrator/pause`
9. **Worker death handling** — 3 malformed JSON responses pause the daemon + escalate
10. **Append-only audit** — every decision in `vault/_orchestrator/decisions-<date>.md`

## Legacy notes

- The old Omni-pane mechanism (`omniPaneId`, `OM` badge, NOTIFICATION text injection) was removed.
- Legacy files from the original wezbridge monolith (~25 files: terminal-orchestrator, session-manager, telegram-bot, webapp, etc.) have been archived to `tmp/legacy-src/`. They are NOT part of the current codebase.
- `src/mcp-server.cjs` exposes MCP tools for manual control from any other Claude Code session — still supported.

## When NOT to be the orchestrator worker

If you (the Claude Code session reading this CLAUDE.md) are NOT in `vault/_orchestrator-worker/`, you are a regular dev session. You can edit any file in this repo. Use the orchestrator API endpoints to interact with the daemon, or use MCP tools from `src/mcp-server.cjs`.

If you ARE in `vault/_orchestrator-worker/`, you must follow the strict JSON contract in `vault/_orchestrator-worker/CLAUDE.md`. Never deviate.

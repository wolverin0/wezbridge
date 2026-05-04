# Handoff — Pane 21 (pather) babysit + 2.7.0 revert

**From:** Claude Code session, 2026-05-04 ~00:25 ART
**To:** next Claude Code session in wezbridge after `/clear`
**Reason:** session context filling; user clearing to keep babysit work alive across the boundary

---

## ⏰ Active task — babysit pane 21 (pather)

User directive (verbatim 2026-05-04 ~00:00):
> "monitor the tab 6 pather-saas so it gets the job fully done and tested"

**What pane 21 is doing right now:**
Fixing 11 stale Playwright tests + 2 vitest failures on `pather` (branch `phase-12-saas`). Both vitest tests already green (bom.test.ts + layoutLiveRepro.test.ts). a11y.spec.ts also green. Currently mid-investigation on `pather.spec.ts` (3 failures) — tracing `handleImportProject` in `useProjectIO.ts` to figure out why a `Notice` modal isn't firing in test scenario.

**Pane 21 last-known state (00:25):**
- Branch: `phase-12-saas`
- Ctx 94% (943k/1M) — climbing slowly (~4k per 2.5min)
- Session 8%, Weekly 76%
- TodoList: 1 in_progress: "Fix all stale tests across vitest + playwright"
- ⏵⏵ bypass permissions on
- Last visible activity: reading `src/hooks/useProjectIO.ts`, "Fixing stale tests… 6m 14s thinking"

**What's left after pather.spec.ts:**
- interactive-walkthrough.spec.ts (settings optical config)
- real-backend.spec.ts (register flow)
- walkthrough.spec.ts (every tab)
- visual/*.spec.ts (4 snapshots — likely needs `--update-snapshots`)

## 🚨 Babysit-mode rules

| Trigger | Action |
|---|---|
| Pane idle at `❯` with active todo | `mcp__wezbridge__send_prompt` to nudge ("continue") |
| Permission prompt visible | `mcp__wezbridge__send_key` with y/n based on context |
| Ctx > 96% | `send_prompt` to suggest "/handoff into handoffs/ then /clear" |
| Output unchanged 5+ min | `read_output` deeper, then send "still working? what's blocking?" |
| Process exit / pane closed | report to user; do NOT respawn unless asked |

**Polling cadence:** 4 min normal, 2.5 min when ctx > 95%.

## 🔑 Key MCP tools (verified working post-restart)

```
mcp__wezbridge__discover_sessions     ← list panes
mcp__wezbridge__read_output(pane_id)  ← scrollback
mcp__wezbridge__send_prompt(id, text) ← inject prompt
mcp__wezbridge__send_key(id, key)     ← y/n/enter/ctrl+c
mcp__wezbridge__kill_session(id)      ← only on user request
mcp__wezbridge__spawn_session         ← only on user request
mcp__wezbridge__wait_for_idle, get_status, auto_handoff
```

Wezbridge MCP is on **2.7.0 path** (`src/mcp-server.cjs` → dashboard daemon `:4200`). Daemon must be running for tools to work — `npm run dashboard` if not.

## 📦 Today's full session arc (2026-05-03 → 2026-05-04)

The rollback story is documented separately in `docs/ROLLBACK-2026-05-03-orchestra-goose.md` — read that for full context.

TL;DR:
1. Morning: shipped stop-the-cycle plan (debate 002 P0/P3/P1/P2)
2. Mid-day: built tier2-build-wave + tier2-plan-and-build recipes; built todomax W0-W11 autonomously via Tier-2 (~3.5h, 17 commits)
3. Evening: built W12-fixes wave (alembic-on-startup + 422 mapping + email TLD + favicon)
4. Late: user reviewed and reverted the Tier-2 architecture; restored 2.7.0 (Claude Code orchestrator + wezbridge MCP)
5. Now: babysitting pane 21 on the legitimate 2.7.0 control surface

## 🗂️ Repos touched today

| Repo | What changed |
|---|---|
| `Py Apps/wezbridge` | CLAUDE.md banner re-scoped, src/DEPRECATED.md re-scoped, .mcp.json → v2.7, dashboard daemon restarted, debate 002 archived |
| `Py Apps/orchestra-goose` | tier2-build-wave.yaml + tier2-plan-and-build.yaml + spawn-2-panes test (cold storage now) |
| `Py Apps/todomax` | NEW: 17 commits, full Docker stack + auth + CRUD + everything per PRD. Real working app. |
| `~/.claude.json` | wezbridge entry → v2.7 src/mcp-server.cjs |
| `~/.claude/skills/wave-kickoff/` | NEW skill (discipline checklist, no infra dep) |

## ⚠️ Don't do

- Don't dispatch goose for new work (cold storage, only for genuine fire-and-forget)
- Don't touch the wezbridge dashboard UI files in `src/dashboard.html` (vaporware, archived)
- Don't change MCP config without restarting Claude Code afterward (per mm-7c0d)
- Don't re-introduce wezterm-cli-bypass patterns when wezbridge MCP works

## 📝 Recent MM claims worth knowing

- mm-577d~12 (revert decision)
- mm-7c0d (Claude Code MCP config caches at session start — full restart needed)
- mm-4150 (wezbridge MCP global vs project config split)
- mm-d598~2 / mm-6590~2 / mm-577d~10 (Tier-2 validation arc)
- mm-216b (peer-pane recipe path-translation bug)
- mm-a213 (Anthropic edge transient rate-limit)

Surface via `mcp__memorymaster__query_memory` with topic if needed.

## 🎯 Next-session opening move

1. Resume MM hooks should auto-fire and inject this handoff into your context
2. `mcp__wezbridge__discover_sessions` to confirm panes still alive
3. `mcp__wezbridge__read_output(21, 80)` to check pane 21 progress
4. If pane is healthy & working → continue normal poll cadence
5. If pane is idle / stuck → babysit-mode rules above

Keep babysit running until pane 21 either:
- Completes all 11 Playwright fixes (todo done) → report to user
- Hits a blocker that needs user input → surface to user
- Auto-compacts mid-task → wait for it to recover, then poll
- User says "stop" → stop

Stay quiet otherwise; user is doing other things.

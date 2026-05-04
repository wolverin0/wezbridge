# Rollback record — orchestra-goose Tier-2 → wezbridge 2.7.0

**Date:** 2026-05-03 → 2026-05-04 ART
**Decision:** revert from orchestra-goose Tier-2 multi-wave architecture back to omniclaude / wezbridge 2.7.0 (Claude Code as orchestrator + wezbridge MCP + Telegram).
**Status:** complete. wezbridge daemon running on :4200, MCP on v2.7 `src/mcp-server.cjs`, debate 002 recipes in cold storage.

This document exists so we don't forget we tried orchestra-goose. It captures what we built, what worked, what didn't, and **why we backed off**.

---

## What we built (between 2026-04-29 and 2026-05-03)

### debate 002 + stop-the-cycle plan (morning of 2026-05-03)

After 3 failed iterations on an "omni orchestrator" (omniclaude → theorchestra v3 → orchestra-goose Wave 5), ran a multi-LLM debate (Claude + Codex; Gemini rate-limited). Both responding advisors converged on **stop iterating, ship narrow phases**. Output:

- Debate artifact: `wezbridge/debates/002-orchestrator-cycle-stop/`
- P0: tagged orchestra-goose `pre-stop-cycle-2026-04-30`, marked Wave 5 BLOCKED, soft-deprecated theorchestra v3 dashboard UI (overzealous — daemon was needed; corrected during this rollback)
- P3: shipped `orchestra-goose/tests/integration/spawn-2-panes-both-commit.sh` — proof that wezterm-cli spawn+send works
- P1: shipped `orchestra-goose/recipes/peer-pane.yaml v2.0.0` — single-pane wezterm-cli spawn primitive (replaced broken summon Task tool)
- P2: shipped `~/.claude/skills/wave-kickoff/SKILL.md` — discipline checklist as a portable skill

### Tier-2 autonomous orchestrator (afternoon of 2026-05-03)

User wanted goose to autonomously orchestrate Claude Code worker panes. Built:

- `orchestra-goose/recipes/tier2-build-wave.yaml` — single-wave dispatch (spawn pane → launch claude → send directive → poll sentinel → write status JSON → cleanup)
- `orchestra-goose/recipes/tier2-plan-and-build.yaml` — multi-wave loop (iterates per-wave dispatch synchronously)

### todomax — real-app dogfood validation

- New project at `Py Apps/todomax/` — feature-rich todo app, ~30 features per PRD, full FastAPI + Postgres + Redis + React + Docker
- Built autonomously via Tier-2: W0 + W1 + W2-W11 (10 waves) + W12-fixes
- 17 commits, ~3.5 hours autonomous
- Runs end-to-end: signup → JWT → todo CRUD all verified via curl + Playwright

## What worked

- The peer-pane / Tier-2 / multi-wave recipe pattern is **technically sound**. 11 waves shipped clean, zero human interventions after initial dispatch (post-recipe-fixes).
- The integration test pattern (`spawn-2-panes-both-commit.sh`) catches real failure modes that summon Task tool let through.
- The wave-kickoff skill (verification gate discipline) is reusable and survives the rollback.
- Edge-rate-limit retry behavior (just retry once on `errorKind: rate_limit`) — the failure mode is transient, not a usage cap.
- Tier-3 worker autonomously recovered from path-translation bugs mid-build (Claude Code worker is resilient).

## Why we backed off

**The trade was wrong for the user's actual workflow.**

| Lost (going to Tier-2) | Gained |
|---|---|
| Tight-loop control via `mcp__wezbridge__send_prompt` / `read_output` | Fire-and-forget autonomy |
| Telegram remote-control presence | Recipe-as-portable-artifact |
| Cheap mid-task intervention | Per-wave context partitioning |
| Live observability via SSE event stream | "Tier-1 hands off N waves and walks away" capability |

**The user works at the keyboard during dev, doesn't actually need walk-away autonomy daily.** The fire-and-forget trade only earns its cost on:

- Mass-update sweeps (rename across 50 files, etc.)
- Cross-codebase migrations (apply same change to 7 repos)
- Audit + remediation passes (fix N issues across N modules)
- Multi-wave PRD'd work like fembeing's 19-wave run

Daily feature/fix work is one-shot territory.

## What was reverted

| Step | What |
|---|---|
| 1 | Restarted `wezbridge/src/dashboard-server.cjs` on port 4200 (it was killed by the overzealous P0 deprecation) |
| 2 | Re-scoped `wezbridge/src/DEPRECATED.md` from "whole daemon dead" → "only the dashboard UI is dead, daemon stays active" |
| 3 | Reverted `wezbridge/CLAUDE.md` banner from "🛑 DEPRECATED" → "STATUS 2026-05-03: 2.7.0 control surface restored" |
| 4 | Reverted `wezbridge/.mcp.json` from v3 `bin/theorchestra-mcp.js` (port 4300) → v2.7 `src/mcp-server.cjs` |
| 5 | Reverted global `~/.claude.json` mcpServers.wezbridge to same v2.7 path |
| 6 | Updated `~/.claude/plans/fuzzy-napping-bear.md` Wave 5 to REVERTED status with full salvage list |
| 7 | Required full Claude Code restart to pick up MCP config changes (per mm-7c0d gotcha) |

Commit: `wezbridge 5b441da` — "revert: 2.7.0 control surface restored (per debate 002 follow-up review)"

## What's salvaged (still earning its keep)

| Artifact | Path | Why kept |
|---|---|---|
| /wave-kickoff skill | `~/.claude/skills/wave-kickoff/SKILL.md` | Discipline checklist, no infra dep, useful on any non-trivial change |
| Spawn-2-panes integration test | `orchestra-goose/tests/integration/spawn-2-panes-both-commit.sh` | Pattern to port to wezbridge/tests/ as MCP smoke test |
| MemoryMaster claims (~30) | MM DB | Surface via recall when relevant (path semantics, rate-limit, etc.) |
| todomax repo | `Py Apps/todomax/` | A real working app, standalone |
| debate 002 | `wezbridge/debates/002-orchestrator-cycle-stop/` | The "stop iterating, ship narrow" lesson stands |

## What's cold storage (don't use, but don't delete)

- `orchestra-goose/recipes/tier2-build-wave.yaml` — single-wave dispatch
- `orchestra-goose/recipes/tier2-plan-and-build.yaml` — multi-wave loop
- `orchestra-goose/recipes/peer-pane.yaml` — pre-Tier-2 single-pane primitive
- All of orchestra-goose's W2/W3/W4/W6 work (MM-MCP, GN/graphify integration, hooks port) is separately useful and stays alive — orchestra-goose isn't deleted, just not the daily-driver orchestration substrate.

## When to revisit Tier-2 / orchestra-goose

If we ever need:

- A genuine fire-and-forget multi-day run (e.g. mass migration of 7+ projects)
- Autonomous scheduling without a chat session (would need `goosed` daemon path, not yet wired)
- Cross-cutting refactor across repos with risk-isolated commits

…the recipes are there. They work. They sit cold until that need is concrete.

## Meta-lesson

**Dispatch shape should match work shape.**

- Toy / well-known apps (todomax) → one-shot single-Claude session
- Daily feature/bug work on existing apps → Claude Code direct via wezbridge MCP (this is the 2.7.0 default)
- Multi-wave PRD'd work with cross-cutting concerns → wave-kickoff discipline + manual dispatch
- True fire-and-forget mass operations → orchestra-goose Tier-2 (rare, specialty tool)

The mistake today wasn't *building* Tier-2; it was *framing it as the daily driver*. Tier-2 is a specialty tool used 1-3 times per quarter, not the substrate for "I want to build X" requests.

## Time invested

- ~16 hours across 2026-04-29 → 2026-05-03 building orchestra-goose Wave 1-6 mechanical infra (most still useful)
- ~6 hours on 2026-05-03 building Tier-2 + todomax + verification
- ~30 minutes for the rollback itself

## Don't forget

We tried this. It works. We chose not to use it daily. If "should we autonomously dispatch this?" comes up again, the answer is probably still no for daily work — but the tools exist if scope justifies them.

## See also

- `wezbridge/debates/002-orchestrator-cycle-stop/synthesis.md` — the multi-LLM debate
- `~/.claude/plans/fuzzy-napping-bear.md` — the orchestra-goose PRD with REVERTED status on Wave 5
- `~/.claude/skills/wave-kickoff/SKILL.md` — the discipline that survives this rollback
- MM claims `mm-577d~*` family for the full session arc

# Debate 002 — Stop the omni-orchestrator iteration cycle?

**Date:** 2026-04-30
**Style:** thorough (1 round, authoritative moderation, 300 words/advisor)
**Models:** Gemini default, Codex default, Claude Opus 4.7

## The question

We have iterated 3 times on building an "omni orchestrator" for multi-project AI dev orchestration and each attempt has failed catastrophically. Should we refuse to attempt iteration 4 and instead ship 5 narrow phases that productize the human-in-the-loop pattern that actually works?

## The 3 failed iterations

1. **omniclaude** (retired) — Claude Code session as orchestrator polling other panes via PTY scrape. Broke on cross-project context bleed at 3-5 panes (mm-09b1).

2. **theorchestra v3** (effectively dead) — wezbridge dashboard daemon with worker pane + JSON I/O contract. Backend `/api/panes/:id/queue` and `/api/panes/:id/inject-context` ship as explicit noops; UI buttons are fakes.

3. **orchestra-goose** (current, ~95% Wave 1-6 mechanical infra) — Goose fork. First real multi-agent integration test today (summon-extension Task tool fan-out, 2 sub-agents reviewing fembeing) hung at 0% progress for 35 minutes. Sub-agents dispatched but never called the LLM. Single-agent goose works fine; multi-agent under the claude-acp adapter is functionally broken.

## The cost

- ~1000+ engineering hours across the 3 iterations
- Millions of tokens
- Output from the AUTONOMOUS-orchestrator pillar of all 3: zero coordinated multi-agent ships
- Output from the MANUAL human-in-the-loop pattern (Claude Code orchestrator + goose pane worker + kickoff template + manual gates): 19 fembeing waves shipped in 17 hours today

## The proposed plan (mm-3da0)

STOP iterating. Refuse iteration 4. Treat the human-in-the-loop as a permanent component, not a thing to remove. Ship 5 narrow phases:

- **P0** — tag orchestra-goose, mark Wave 5 (multi-pane via summon) BLOCKED, archive theorchestra v3 dashboard
- **P1** — rebuild Wave 5 as a "peer-pane" recipe using `wezterm cli spawn` + `wezterm cli send-text` (the proven wezbridge-compat path), NOT goose's broken Task tool. ~1 week
- **P2** — productize the wave-kickoff template as a portable skill. 3-4 days
- **P3** — integration tests for orchestra-goose's actual claimed capabilities (the "spawn 2 panes and have both commit" test that would have caught the W5 hang on day 1). 3-4 days
- **P4** — sunset legacy IF P1-P3 land
- **P5** — explicitly NOT BUILDING the autonomous orchestrator (this is the unique commitment — usually we say "later")

## The question for advisors

Three possible positions:

1. **AGREE with stop-the-cycle**: ship the 5 phases, the human-in-the-loop is the right shape, P5's refusal-to-build is wisdom not defeat
2. **DISAGREE — try iteration 4**: there's a 4th architectural approach the previous 3 missed (name it concretely with file paths if possible)
3. **DISAGREE differently**: the framing is wrong; the real issue is X (specify)

What is the single biggest risk of the stop-the-cycle plan? And is there a way to rescue iteration 4 cheaply (e.g., a 2-day spike) before committing to "never again"?

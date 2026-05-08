# PLAN: Managed Agents Backfill into wezbridge v2.7.0

**Date**: 2026-05-07
**Decision context**: Anthropic launched Claude Managed Agents (open beta) with multi-agent coordinator+specialists, server-side Outcomes rubric grading, webhooks with `requires_action` pre-execution block, and Dreams memory curation. Pricing: $0.08/session-hour active runtime + standard token rates. Full specs: MM claim `mm-3627`.

**Decision**: stay on local stack. Reasons:
- $0.08/h × idle panes = wasted spend (anoche pane 12 idle 5h post-ship would have been $0.40 floor).
- Local stdio MCPs (wezbridge / memorymaster / gitnexus / serena / context7 / repomix / 21st-magic / openclaw2claude / playwright) NOT bridgeable; only `mcp_oauth` HTTP+OAuth supported.
- Multi-LLM: Codex gpt-5.5, Gemini, Goose recipes orchestrable locally; Managed Agents is Anthropic-only.
- Already-proven results: 9-PR visual sprint + 10-finding audit shipped autonomously last 24h with zero nudges (mm-2f2a, mm-9d0b).

**But there are 3 real gaps** Managed Agents would close that local stack currently can't:
1. Pre-execution destructive-op block-layer — `wezterm cli get-text` polling is post-hoc only (mm-d752).
2. Server-side rubric grader in isolated context window — replaces post-hoc spot-check (mm-c407).
3. Headless `claude --print --chain` does NOT iterate — single-shot only (mm-3da9).

This plan backfills those gaps locally without paying $0.08/h or losing MCPs/multi-LLM. **Surgical adds to v2.7.0; no rewrites.**

---

## Codex's 7 ideas (verbatim, gpt-5.5 high via codex:rescue 2026-05-07)

### 1. PATH-Based Destructive Command Gate
**Rationale**: closes gap 1 by blocking `git push origin main`, `gh pr merge`, `git * --force`, etc. before the real binary runs.
**Implementation**: create `bin/guard-shims/{git,gh}.cmd` + `.sh`, `scripts/command-guard.cjs`; optionally launch panes through `bin/guarded-claude.*` from `src/dashboard-server.cjs` / `src/mcp-server.cjs` behind `WEZBRIDGE_GUARD_SHIMS=1`. **Estimate: 180-280 LoC.**

### 2. Shared Safety Policy For MCP And Dashboard Actions
**Rationale**: gap 1 also includes wezbridge-native destructive actions like `kill_session`, worktree cleanup/merge, broadcast, and prompt injection.
**Implementation**: create `src/safety-policy.cjs`; call it from `src/mcp-server.cjs` cases `send_prompt`, `send_key`, `kill_session`, `auto_handoff`, and from `src/dashboard-server.cjs` handlers `handlePostPrompt`, `handlePostKey`, `handlePostKill`, worktree routes. Return `{allowed, reason, overrideToken?}`. **Estimate: 120-220 LoC.**

### 3. Async Outcome Rubric Grader Sidecar
**Rationale**: fills gap 2 by turning every `A2A type=result` or `session_completed` into a cheap structured verifier instead of manual spot checks.
**Implementation**: create `scripts/outcome-grader.cjs` that gathers pane tail via `wez.getFullText`, optional `git diff --stat`, active task text, then runs `claude -p --output-format json --permission-mode plan` or `codex exec` when configured; add `/api/grade` and optional auto-trigger in `src/dashboard-server.cjs`. **Estimate: 180-320 LoC.**

### 4. Rubric Result Events And Dashboard Badges
**Rationale**: gap 2 needs the grade to affect orchestration, not just produce a file.
**Implementation**: extend `src/dashboard-server.cjs` SSE with `outcome_grade` events, keep an in-memory LRU keyed by `corr`/pane id, expose `GET /api/grades`, and add a small badge column in `src/dashboard.html` for pass/warn/fail. No dependency changes. **Estimate: 120-220 LoC.**

### 5. A2A Heartbeat SLA Watcher
**Rationale**: gap 3, high leverage — existing docs require progress every ~3 min, but enforcement is still TODO, so silent specialists waste whole panes.
**Implementation**: extend existing `a2aState` in `src/dashboard-server.cjs` to track `lastProgressAt`, emit `a2a_silent` SSE after threshold, and optionally send an A2A nudge via existing `wez.sendText` only when target is idle. **Estimate: 80-160 LoC.**

### 6. Persistent Team And Worktree Manifest
**Rationale**: gap 3, high leverage — Managed Agents' roster survives server state; current `teamsRegistry` / `worktreeRegistry` are process memory only.
**Implementation**: create `vault/_wezbridge/teams.jsonl` or `src/team-manifest.cjs`; append team spawn, role ownership, worktree path, corr ids, grade status; reload into dashboard on boot without changing pane I/O. **Estimate: 100-180 LoC.**

### 7. Memory Inbox For Blocks And Grades
**Rationale**: gap 3, high leverage — backfills "Dreams"-style curation locally by preserving only safety blocks, failed grades, and non-obvious outcomes.
**Implementation**: create `src/memory-inbox.cjs`; write JSONL to `vault/_memorymaster/inbox.jsonl` from `command-guard`, safety policy, and outcome grader behind `WEZBRIDGE_MM_INBOX=1`. **Estimate: 80-140 LoC.**

---

## Claude additions (5)

### 8. Telegram Bidirectional Ack
**Rationale**: when item #1 or #2 blocks a destructive op, the babysit loop currently routes through the orchestrator session (me). Push the decision to the user's phone via Telegram inline keyboard, callback unblocks the pane.
**Implementation**: extend `src/safety-policy.cjs` (item #2) — on block, send Telegram message via `Inner_Ricardo_bot` with inline keyboard `[Approve] [Deny] [Show diff]`. Add `/api/telegram-callback` route to receive button taps, post `user.tool_confirmation` equivalent (release the lock). Reuses existing `~/.omniclaude/telegram-topics.json` config. **Estimate: 120-200 LoC.** Depends on: #1, #2.

### 9. Per-Pane Cost Meter
**Rationale**: validate the "local vs Managed Agents" decision quantitatively over time. wezbridge already tracks pane lifecycles; add cost estimation.
**Implementation**: create `src/cost-meter.cjs` that hooks pane spawn/idle/close, estimates tokens × model rate (approximate; map status-bar `Ctx Used: X%` deltas), accumulates daily/weekly. Expose `/api/costs` + dashboard widget. Compare actual cost vs hypothetical Managed Agents cost ($0.08/h × elapsed + tokens). **Estimate: 150-250 LoC.** No dependencies.

### 10. Pre-Push Auto-Review Hook
**Rationale**: catches issues before remote; integrates with #1+#2's destructive-op gate.
**Implementation**: git `pre-push` hook (per-repo opt-in via `npm run wezbridge:install-hooks`) that spawns `codex:rescue` review of the diff against main. If review surfaces criticals, abort push (returns non-zero). Pipes review output via Telegram (#8) for review-on-phone. **Estimate: 80-140 LoC.** Depends on: #1.

### 11. Worktree-Clone Replay For Risky Ops
**Rationale**: when #2 blocks `gh pr merge`, don't just deny — show what the merge WOULD do.
**Implementation**: in `src/safety-policy.cjs`, on block → `git worktree add /tmp/wezbridge-replay-<corr>` from base branch → run the merge there → capture `git diff main..HEAD --stat` + any conflict markers → present preview in Telegram (#8) with allow/deny buttons. Cleanup worktree on decision. **Estimate: 100-180 LoC.** Depends on: #2, #8.

### 12. Sidecar Audit Pane (revives L2 from BRAINSTORM-look-ahead-context)
**Rationale**: item #3 is ephemeral per-result; for multi-phase PRDs the executor pane benefits from a CONTINUOUS rubric grader.
**Implementation**: dashboard option to spawn a paired sidecar pane (`mcp__wezbridge__spawn_session` with `persona=sidecar`) that watches its assigned coder mid-response, runs rolling audits on phase N while coder is on phase N+1. Updates `vault/_wezbridge/teams.jsonl` (#6). Cost: 2x pane count. **Estimate: 150-250 LoC.** Depends on: #3, #6.

---

## Priority + dependency ordering

```
Tier 1 (no deps, ship first — closes the destructive-op gap):
  1. PATH-Based Destructive Command Gate                  [180-280]
  2. Shared Safety Policy For MCP And Dashboard Actions   [120-220]
  9. Per-Pane Cost Meter                                  [150-250]  ← independent, easy win

Tier 2 (depends on Tier 1):
  3. Async Outcome Rubric Grader Sidecar                  [180-320]  ← fills gap 2
  4. Rubric Result Events And Dashboard Badges            [120-220]  (deps: 3)
  5. A2A Heartbeat SLA Watcher                            [ 80-160]  ← independent, easy
  6. Persistent Team And Worktree Manifest                [100-180]  ← independent

Tier 3 (depends on Tier 2):
  7. Memory Inbox For Blocks And Grades                   [ 80-140]  (deps: 1, 2, 3)
  8. Telegram Bidirectional Ack                           [120-200]  (deps: 1, 2)
 10. Pre-Push Auto-Review Hook                            [ 80-140]  (deps: 1)
 11. Worktree-Clone Replay For Risky Ops                  [100-180]  (deps: 2, 8)
 12. Sidecar Audit Pane                                   [150-250]  (deps: 3, 6)
```

**Total estimated**: 1,460–2,540 LoC for full backfill.

**Recommended first push** (closes the destructive-op gap that motivated this plan): items **1 + 2 + 9** = 450–750 LoC. After that, **8 + 10** add the Telegram-on-phone loop = 200–340 LoC.

## Open questions to validate per item

- **#1 PATH gate**: how to handle pane-spawned-from-pane shells (does `WEZBRIDGE_GUARD_SHIMS` env propagate to nested wezterm spawns)?
- **#2 safety policy**: classifier vocabulary — does it cover `git reset --hard`, `npm publish`, `docker rm -f`, file `rm -rf` outside repo?
- **#3 grader**: what model? `claude -p` is cheap but token-bound; for large diffs prefer `codex exec` with gpt-5.5? Let it be configurable.
- **#8 Telegram**: bot Privacy Mode is ON (per memory mm-Inner_Ricardo_bot) — only DMs/@mentions reach the bot. Inline keyboards bypass this restriction.
- **#9 cost meter**: token estimation from status-bar `Ctx Used:` is approximate; for accurate cost track via Anthropic API usage endpoints if available, otherwise accept ±20% error.

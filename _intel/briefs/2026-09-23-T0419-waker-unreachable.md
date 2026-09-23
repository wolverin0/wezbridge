<!--
DOC-HEAD: T-0419 brief — orchestrator-waker deliverPending() early-returns on
non-idle target BEFORE attempts/flags fire, so intents pile up forever in
pending.json against an unreachable/unknown-status target. Fix: track
not_idle_since per target and flag with a distinct "target-unreachable"
reason after a bounded window, distinct from the maxAttempts cap reason.
Covers waker-gate.cjs reason differentiation too. Read before touching
src/orchestrator-waker.cjs or scripts/waker-gate.cjs flagging logic.
-->

# T-0419 — waker: target permanently non-idle never gets flagged

tier=T3 repo=wezbridge branch=fix/t0419-waker-unreachable

## Problem
In `src/orchestrator-waker.cjs`, `deliverPending(panes)` (~L611) returns early
when the target's status !== 'idle' (~L619:
`if (status !== 'idle') { state.idleStreak = 0; return; }`), BEFORE any
intent's `attempts` is touched. The attempt cap (`cfg.maxAttempts`, ~L805) and
the flags writer (~L342: flags.json `{...intent, flagged_at, reason}`)
therefore never fire for a target that is permanently not idle (status
'unknown', dead selector, etc.). Intents in pending.json pile up with
attempts=0 forever. `scripts/waker-gate.cjs` does go RED by age, but prints
"pokes produced and not consumed", which points at the consumer when the real
problem is the DESTINATION.

## Acceptance criteria (from the card, binding)
1. FAIL-FIRST: write a test that runs N ticks with the target in status
   'unknown' and >=1 pending intent, and show it FAILING against origin/main
   HEAD before the fix (pending grows / attempts stays 0, no flag). Paste the
   red output in the report — without it the rest doesn't count. Commit the
   test and fix separately (test commit first) so the red is reproducible.
2. After the fix: target not idle for a bounded, configurable window -> the
   intent leaves pending and lands in flags.json with its OWN reason that
   names the destination (e.g. `target-unreachable: <repo/pane> not idle for
   <window>` — not the failed-attempts cap text). Assert on the CONTENT of
   flags.json, not on a log line.
3. GUARD: a target only briefly busy (status 'working' for a short burst <
   window) is NOT flagged; the intents stay pending without a flag. Decide
   and document whether a long 'working' should count (card intent:
   'unknown'/unreachable is the problem; don't turn this into "flag any pane
   that isn't idle"). A reasonable design: track per-intent (or per-target)
   `not_idle_since`, reset when idle is seen; flag only when non-idle
   continuously >= window; consider using a longer window or excluding
   'working' — justify it in the report.
4. `scripts/waker-gate.cjs` prints the distinct reason so its RED output
   separates "consumer not consuming" from "destination unreachable". Test
   it.
5. The window is an operational value in source or waker config (cfg default
   in orchestrator-waker.cjs and/or `_intel/orch-waker.json` override) —
   greppable in a versioned file. Tests must use an isolated state dir, never
   the real `_intel`.
6. Run touched test files with `node --test` and `npm test` (report counts;
   known pre-existing failures: model-tiers ENOENT in worktrees, mcp-server
   T-0281 AC3/AC4, timing flakes lane-hooks p95/daemon-cli/pretool-guardrail-
   jev). Mutation: remove the new flagging branch -> the AC2 test fails.

## Constraints
Minimal diff; check callers of anything changed (grep). Don't restart the
daemon or touch the main checkout. Commits: `test(waker): ...` then
`fix(waker): ...`, each ending with
`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. No push, no merge.

## Close format
```
[WORKER_DONE] task_id=T-0419 branch=<branch> commit=<sha>
criteria:
- AC1..AC6: pass|fail — evidence
files_changed: <list>
next_action: <...>
```

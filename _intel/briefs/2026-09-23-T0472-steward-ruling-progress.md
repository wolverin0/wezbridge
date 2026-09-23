# T-0472 — steward channel-3 ruling liveness self-suppression (brief)

> **Covers:** the fleet-steward bug where operator-gated/deferred rulings written BY the
> orchestrator reset the abandoned-lease/stale-running quiet clock, silencing the alarm they
> should have left ringing. **Key terms:** buildContext, ownProgress, lastProgress,
> RULING_NOT_LIVENESS, rulingAt, channel 3. **Read this when:** touching fleet-steward.cjs's
> progress channels or rulings.jsonl schema. **Status:** CLOSED 2026-09-23, fix on
> fix/t0472-steward-ruling-progress.

## Problem (root cause known)
`scripts/fleet-steward.cjs` channel 3 of `lastProgress()` (~L216) -> `ownProgress()` (~L206-212)
pushes `ctx.rulingAt.get(task.id)`; `buildContext` (~L252-263) builds rulingAt from ANY ruling in
rulings.jsonl for the task, regardless of source or content. So each time the orchestrator writes
an `operator-gated`/`deferred` ruling on a stuck card -- rulings that literally say nobody is
working it -- the card's quiet clock resets and abandoned-lease / stale-running / stall findings
are pushed 24h further out. A self-suppression loop. Census of 31 suppressed live cards:
`_intel/results/T-0472-suppression-census-20260918.md` (20 operator-gated, 8 deferred, 2
dispatched, 1 resolved; all source=orchestrator-pane). Same lesson as T-0144 (channel 1 fixed by
reading state_changed_at instead of updated_at).

Design constraint (binding): rulings whose kind/outcome is `operator-gated` or `deferred` must
NOT count as liveness. `resolved`/`cancelled` are harmless. `dispatched` decision: KEPT as
liveness -- it asserts a handoff happened (a different claim from "nobody is on this"), and an
existing tested contract (test/fleet-steward-progress.test.cjs:133) already relies on it counting.

## Acceptance criteria (card, binding)
1. FAIL-FIRST REAL test in test/, running card + expired lease whose ONLY progress is an
   operator-gated ruling with source=orchestrator-pane -> assert fleet-steward emits
   abandoned-lease. RED against origin/main, GREEN after the fix. Test committed before the fix.
2. Against the LIVE _intel, READ-ONLY: confirm the read path writes nothing, then show
   before/after for T-0193, T-0333, T-0350, T-0354, T-0332 (or replacements if closed).
3. Anti-false-RED: T-0146/T-0164 sibling-liveness tests stay green.
4. Channel-3 doc-comment in fleet-steward.cjs states which rulings count; one bullet added to
   the real `_intel/ORCHESTRATOR.md` (uncommitted, different repo -- diff pasted in the close
   report).
5. `node --require ./test/setup.cjs --test` on steward files pass; `npm test` counts against the
   known pre-existing failures list. Mutation: revert the filter -> AC1 test fails.

## Outcome
Fixed by narrowing channel 3 to a `RULING_NOT_LIVENESS = new Set(['operator-gated', 'deferred'])`
filter inside `buildContext()`. Full evidence and before/after numbers are in the close report
delivered to the orchestrator (see task T-0472 in the ledger and the worker's SubagentHandback).

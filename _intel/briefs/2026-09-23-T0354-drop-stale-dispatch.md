# T-0354 — Drop a stale dispatch instead of redelivering it

Covers: `src/project-queue.cjs` (`deliverPending`, new `screenCardState`), the per-project
queue drain path (`scripts/queue-drain.cjs`), and the ledger card read (`_intel/tasks/<id>.json`,
mirrors `_docs-curation/ledger.cjs` STATES/`dispatchable()`). Bug: a `type=request` dispatch
whose card moves to blocked/done/cancelled AFTER it is already pending in the queue kept
getting redelivered verbatim on every drain — measured 2026-09-04 with T-0262 (attempts=2,
infra pane explained twice that the card was closed). Fix: re-read the card immediately
before each delivery attempt and drop (not redeliver) if its state no longer admits dispatch.
Read this before touching the queue's delivery loop or the dispatch-time gate in `a2a-intel.cjs`.

## Problem
Measured 2026-09-04: a headless turn enqueued the dispatch of T-0262 at 14:07 with the old
scope. At 14:19 the card went blocked/blocked_by=operator and at 14:5x its scope was
corrected, but the queue kept redelivering the SAME envelope (attempts=2): the infra pane
received it twice and had to explain twice that the card was blocked. Evidence:
`_intel/queues/state/infra/pending.json.bak-20260904-t0262-stale`. The queue must re-read the
card before each delivery and drop the envelope if the card's state no longer admits dispatch,
logging `queue.entry_dropped` with the reason.

## Root cause
`deliverPending()` in `src/project-queue.cjs` only checked the SUPPRESSED-drop ring and the
live pane census before resending a pending envelope — never the ledger card. `checkDispatchGate`
in `src/a2a-intel.cjs` already re-reads the card, but only runs ONCE, at `a2a_send` time in
`src/mcp-server.cjs`; a card that closes after the send already durably queued has no later
check point.

## Fix
Added `screenCardState(entry)` inside `createConsumer` (`src/project-queue.cjs`): for a
`type: 'request'` entry whose `corr` resolves to a task id (`taskIdFromCorr`, the one parser
shared with the sender-side gate), re-reads `<base>/tasks/<id>.json` right before the send
attempt in `deliverPending`'s per-entry loop. If the card's `state` is in
`STALE_DISPATCH_STATES = {blocked, done, cancelled}`, the entry is discarded through the
existing `dropEntry()` path (same durable-suppress + `queue.entry_dropped` mechanism already
used for `project-not-live`), never sent. Everything else — non-`request` types, an
unresolvable `corr`, a missing/corrupt card file — fails OPEN and delivers exactly as before;
an unreadable ledger is never grounds to drop the fleet's only durable copy of a dispatch.

## Acceptance (binding — see PR body for evidence)
1. FAIL-FIRST test: a queued DISPATCH envelope whose card is blocked/done/cancelled is
   dropped on the next drain, not delivered, emits `queue.entry_dropped` with the card state
   as reason. RED on origin/main, green after.
2. A dispatch whose card is still dispatchable (ready/queued/running) delivers exactly as
   today.
3. Non-dispatch envelopes (result/ack/progress/error) deliver even if the card is closed; an
   envelope with no resolvable card delivers as today.
4. An unreadable/corrupt ledger fails open — delivers as today, logs a warning, never drops.
5. `test/project-queue*.test.cjs` + `test/queue-drain*.test.cjs` pass; `npm test` shows no new
   failures beyond the documented pre-existing set. Mutation: removing the state check fails
   AC1 only.

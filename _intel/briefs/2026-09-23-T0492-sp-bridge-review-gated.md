<!-- doc-head: T-0492 brief. sp-bridge.isOperatorGated required c.state==='blocked', so
operator-gated cards living in review (T-0332/T-0333/T-0418/T-0462/T-0483, measured 2026-09-20)
never reached the operator's SP list and never auto-closed either (same predicate gates
creation AND completion). Fix widens the predicate to the open FSM states
(ready/queued/running/review/blocked/failed), excluding done/cancelled, mirroring
fleet-board.isOperatorWaiting. Root cause known going in; this is the fix card, not the
investigation (that's _intel/evidence/wezbridge/2026-09-20-preguntas-al-operador-sin-canal.md).
Read before touching isOperatorGated again or any of its callers (T-0494/T-0495 follow). -->

# T-0492 — sp-bridge: cards gated by the operator outside state=blocked never reach SP

## Problem (root cause known)

`scripts/sp-bridge.cjs` ~L126, `isOperatorGated`:

```js
const isOperatorGated = (c) => Boolean(c) && c.state === 'blocked' && (gateOf(c) === 'operator' || c.blocked_by === 'operator');
```

This predicate governs two things in the same file: creating the SP task (`syncDecisions`,
~L304 `cards.filter(isOperatorGated)`) and closing it (~L328,
`if (!isOperatorGated(card) && await completeOnce(ext))`).

Requiring `c.state === 'blocked'` misses cards that carry `blocked_by: 'operator'` while living
in `review` — finished work waiting on the operator's judgement, not blocked work. Measured
2026-09-20 (`_intel/evidence/wezbridge/2026-09-20-preguntas-al-operador-sin-canal.md`):
T-0332, T-0333, T-0418, T-0462, T-0483 all in `state: review`, `blocked_by: operator`, none of
the five present in `_intel/.sp-bridge/map.json`.

## Other callers of the same predicate/semantics

Grepped `blocked_by`/`gateOf` usage across `scripts/*.cjs` and `.agent-workflow/`:

- `scripts/fleet-board.cjs` ~L47-55 already has the CORRECT semantics under a different name,
  `isOperatorWaiting`: `isOpen(t) && (t.blocked_by === 'operator' || gateOf(t) === 'operator')`,
  where `isOpen` checks `OPEN_STATES = ['ready','queued','running','review','blocked','failed']`.
  This fix reuses that exact state universe (duplicated locally in sp-bridge.cjs for a
  localized diff — no cross-file import added).
- `scripts/fleet-steward.cjs` ~L516-531 `auditUnrecordedDecisions` — different concept (detects
  a card that LEFT the gate without a recorded ruling), not touched.
- `scripts/orchestrator-turn.cjs` ~L288/356 — reads `blocked_by` as a field, does not
  re-implement the gate predicate. Not touched.
- `.agent-workflow/graph.json` — no FSM state vocabulary or gate predicate there; it's a
  contract-gate file for capability tiers, unrelated to card state.
- `scripts/validate-intel.cjs` — defines `OPEN_STATES`/`STATES`/`TERMINAL_STATES` vocab used as
  a reference for what "open" means fleet-wide (`ready, queued, running, review, blocked` +
  `failed` per fleet-board). Confirms `done`/`cancelled` are the only terminal states.

## Fix

`isOperatorGated` now checks `OPERATOR_GATE_OPEN_STATES.has(c.state)` instead of
`c.state === 'blocked'`, where `OPERATOR_GATE_OPEN_STATES = new Set(['ready', 'queued',
'running', 'review', 'blocked', 'failed'])` — the same non-terminal universe as
`fleet-board.isOperatorWaiting`. `done`/`cancelled` stay excluded: terminal cards have nothing
left to decide even if `blocked_by` is a stale `'operator'` residue.

Since the same predicate governs both creation and completion, this fixes the forward path
(cards in review now create SP tasks) and preserves the return path (a card that stops being
gated — `blocked_by` cleared, or moved to `done`/`cancelled` — still completes the SP task on
the next sync).

## Tests (test/sp-bridge.test.cjs, T-0492 A-E)

- A: `state=review, blocked_by=operator, gate=null` creates an SP task (fail-first, RED on
  `c.state === 'blocked'`).
- B: idempotent — same card, second sync creates nothing new.
- C: return path via `blocked_by` clearing (`review` → `blocked_by: agent`) completes the task,
  `doneAt` written to the fixture map.json.
- D: return path via `state → done` while `blocked_by` is stale `operator` — still completes.
- E: `done`/`cancelled` never create a decision even with `blocked_by: operator` residue.

Mutation check: reverting to `c.state === 'blocked'` fails A/B/C/D (4 of the 5 new tests), E
still passes (done/cancelled were never in scope either way) — confirms the tests exercise the
mutated line, not incidental behavior.

## Live forward path (read-only, no live sync run) — re-measured 2026-09-23

`sp-bridge.cjs` has no dry-run/plan flag separate from `syncDecisions`. The pure planning step
is `syncDecisions`'s first line, `cards.filter(isOperatorGated)`, which touches nothing by
itself. Reproduced that filter (fixed predicate) against a read-only copy of the logic, fed
with the LIVE `_intel/tasks/*.json` (544 cards) and cross-checked against the LIVE
`_intel/.sp-bridge/map.json`. No writes were made to either.

The 5 cards named in the 2026-09-20 evidence file are ALL resolved now — none would create
anything post-merge:

| card | live state (2026-09-23) | gated under the fix |
|---|---|---|
| T-0332 | done | no |
| T-0333 | done | no |
| T-0418 | cancelled | no |
| T-0462 | done | no |
| T-0483 | done | no |

3 DIFFERENT cards are gated live today and would newly reach SP once this ships and the next
scheduled `sync` runs (none of them have an open `fleet:` entry in the live map.json right
now):

| card | state | blocked_by | gate |
|---|---|---|---|
| T-0412 | queued | operator | null |
| T-0465 | queued | operator | null |
| T-0477 | queued | operator | null |

The 3 cards already gated under the OLD predicate (state=blocked) are unaffected — each already
has an open `fleet:` entry (T-0496 → `fleet:T-0496`, T-0497 → `fleet:T-0497`, T-0557 →
`fleet:T-0557`).

**Live creation is pending post-merge** — the actual sync happens via the normal scheduled
`node scripts/sp-bridge.cjs sync` run. Read-back after that run:

```
node -e "console.log(JSON.parse(require('fs').readFileSync('_intel/.sp-bridge/map.json','utf8')))" | grep -E "T-0412|T-0465|T-0477"
node -e "console.log(JSON.parse(require('fs').readFileSync('_intel/.sp-bridge/last-success.json','utf8')).decisions)"
```

Expect `decisions.created >= 3` on the first post-merge run (T-0412/T-0465/T-0477 at minimum;
more if new cards moved into an open+operator-gated state meanwhile), and three new `fleet:T-0412`
/ `fleet:T-0465` / `fleet:T-0477` entries in map.json without `doneAt`.

## Constraints honored

Minimal diff — one function changed, comment-documented. No push, no merge, no live
`sync-decisions` run, no write to the real `.sp-bridge/*` files. All tests run against fixture
ledgers + the in-memory fake SP plugin in temp dirs (`test/sp-bridge.test.cjs`'s existing
`env()` helper).

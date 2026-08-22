# Autopilot re-enable checklist — gates before wezbridge-orchestrator-turn comes back
> Covers: the 8 gates before re-enabling the `wezbridge-orchestrator-turn` scheduled task
> (autopilot; Status: Disabled as of 2026-08-22; operator flips it, never an agent). Key terms:
> steer/queue/stop verbs, stop-parks-queue, cancelled-stays-cancelled (zombie results), affinity,
> budget, full attribution (actions.jsonl + decisions ledger), waker classifier <20% no-action
> turns, COORDINATORS.json vs orch-waker.json consistency. Read when: re-arming autopilot,
> auditing why it is off, or editing waker/executor code. Sources: docs/research/2026-08-22-harness-software-factory/ 06 §C + 08-synthesis §2.

## Standing rule (read first)

This document does not authorize anything. Re-enabling `wezbridge-orchestrator-turn` is an
**operator-gated** action: every box below must be checked WITH EVIDENCE (a command run and its
output, not a claim), and then the operator — not an agent, not a peer pane — flips the task.
An agent that enables the task, or makes auto-close actually kill a pane, has violated the gate
regardless of how many boxes were green. Auto-close stays **shadow-only** (it logs what it WOULD
close; it kills nothing) until the operator separately rules otherwise.

Context for why the bar is this high: `src/COORDINATORS.json` (`_why`) records five coordinator
iterations, with the stop-decision overridden three times because it was prose. This
checklist is the executable-ish version of that lesson: each item names the thing that must be
able to FAIL before the loop is allowed to drive again — the same re-arm shape the 2026-08-13
disarm record in `_intel/orch-waker.json` prescribed ("only when something downstream of the
poke can FAIL").

## The checklist

### 1. [ ] Steer / queue / stop exist as three DISTINCT verbs
The control surface for a running orchestrator must distinguish (06 §B.3, 08 §2 correction 2):
- **steer** — redirect the ACTIVE turn without killing it;
- **queue** — park the next job somewhere inspectable and editable before it runs;
- **stop** — halt the active turn AND park the queue (see item 2).

Gate: point to the code path (or protocol doc section) implementing each verb, plus one logged
exercise of each against a live orchestrator turn. A single "send text at the pane and hope"
path is zero of the three verbs, not one.

### 2. [ ] Stop parks the queue (stop ≠ skip-to-next)
When the operator stops the orchestrator, the pending queue must NOT auto-fire its next item —
stop halts the current work AND freezes the queue for inspection (06 §B.3). The 2026-08-13
failure mode was exactly this shape: 55 pending intents accumulated and re-delivered because
nothing downstream could fail or hold.

Gate: demonstrate stop with ≥2 items queued; show both items still parked (and inspectable)
afterwards, with the stop and the parked state visible in the action log.

### 3. [ ] Cancelled stays cancelled — no zombie results re-enter
Once a dispatched job is cancelled, a late-finishing worker result must never re-enter the
orchestrator's reality as success (06 §C: "Cancelled stays cancelled in the agent's reality").
Two layers, per the source: a global executor/waker backstop that marks the correlation
cancelled, plus cooperative shutdown inside long-running work. Concretely for this fleet: a
`type=result` arriving for a cancelled corr-id, and a waker intent generated before a
disarm/stop, are both dropped-with-attribution (logged as suppressed, never harvested). The
2026-08-13 record shows the anti-pattern: week-stale mutual results re-delivered after disarm.

Gate: a test or logged drill where a job is cancelled, its result arrives late, and the log
shows the result suppressed — not narrated, not harvested, not queued.

### 4. [ ] Affinity active (model/role-per-task, enforced in the spawn path)
The affinity table (which model/agent tier handles which kind of work — Bot-HR-style
"model-per-role, explained", 08 §3 frente 3) exists as data and is ENFORCED where spawns
happen, not remembered as prose. Related lifecycle rules ride with it: pane cap respected,
auto-close in shadow mode only (see Standing rule).

Gate: show the affinity table file, one spawn that consulted it, and one spawn attempt outside
it being refused or downgraded — with log lines for both.

### 5. [ ] Budget: the loop has a hard ceiling it cannot raise
Autopilot must run under explicit budgets — max orchestrator turns per arming window, max
concurrent panes (tope 5), and a spend/token ceiling for dispatched work — checked
deterministically BEFORE each turn, with breach meaning the loop parks itself and pages the
operator instead of continuing. A budget the loop can edit is not a budget.

Gate: show the budget values as config (not prose), plus one logged instance of the ceiling
being hit and the loop parking rather than proceeding.

### 6. [ ] Full attribution: every action AND every judgment is written down
Two layers (08 §2 correction 3):
- **Action log** — `_intel/actions.jsonl`: who did what and why, for every spawn/kill/turn/poke,
  including $0 skipped wakes.
- **Decision ledger** — every `type=result` and every orchestrator turn hands back the
  decisions made where the spec was silent, ranked least-confident first, with what it would
  have asked. The operator reviews the ledger, not the diff.

Gate: pick any autopilot turn from the last drill and reconstruct, from files alone, what it
did, why, and which judgment calls it made. If reconstruction needs the transcript, attribution
is not full.

### 7. [ ] Waker classifier measured at <20% no-action turns
The waker classifies events deterministically BEFORE waking the LLM (pre-run-gate pattern, 08
§3 frente 2): only results-directed / stall / exception events wake a turn; everything else is
skipped at $0 and logged. Quality bar: across a measured window (≥50 wakes or ≥7 days of
arming), **fewer than 20% of woken turns end with no action taken** — a wake that produces
nothing was a misclassification, and a narrator poked awake to nod is iteration #5's failure
repeating.

Gate: the measurement itself — count of wakes, count of no-action turns, ratio, dates, and the
command that computed it. No window, no ratio, no check-mark.

### 8. [ ] COORDINATORS.json ↔ orch-waker.json consistency check passes
The authorization record (`src/COORDINATORS.json` rulings) and the live arming state
(`_intel/orch-waker.json` `enabled` + waker-gate status) must AGREE before re-enable — a ruling
that says "disarmed" while state says `enabled: true` means one of them is lying to the next
reader. This is not hypothetical: as of 2026-08-22 the COORDINATORS.json ruling for
`src/orchestrator-waker.cjs` still reads "DISARMED 2026-08-13 ... enabled=false" while
`_intel/orch-waker.json` records the 2026-08-19 re-arm with `enabled: true`. That drift must be
reconciled (update the ruling with the re-arm date and its met condition) as part of this item.

Gate: a deterministic check (script or documented command pair) run at re-enable time showing:
ruling text and arming state agree; `scripts/waker-gate.cjs` exits 0; and the scheduled task's
current status was read (`schtasks /query /tn wezbridge-orchestrator-turn`) — flipping it is
then the operator's move, in that order, never an agent's.

## After all eight are green

The operator enables the scheduled task. First arming window runs with the budget from item 5
at its most conservative values and the item 7 measurement re-running live. Any gate regressing
(zombie result observed, no-action ratio ≥20%, budget breach without park) → disable again and
append the incident to the disarm history in `_intel/orch-waker.json` before the next attempt.

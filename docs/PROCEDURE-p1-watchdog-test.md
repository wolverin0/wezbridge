<!-- doc-head: 2026-07-28 ready-to-run procedure for the P1 watchdog recovery test (control-plane v1). Uses a SACRIFICIAL orchestrator-profile pane, never the live pane-0; external grading by the real orchestrator; operator present. Deferred from 2026-07-28 01:05 because killing the live orchestrator would have taken the fleet's monitors down silently with nobody awake. Read when: running P1, or designing any self-test whose subject is the grader. -->

# P1 watchdog recovery test — ready-to-run procedure

**Gate**: automatic recovery of an absent orchestrator pane in <120 s, zero operator action.
**Status**: watchdog armed and timing-tested in CI; **real recovery unmeasured**.

## Why a sacrificial pane (not pane-0)

The watchdog identifies "the orchestrator" by **repo name** (`WEZBRIDGE_ORCH_REPO`, default
`wezbridge`) — any Claude pane whose project basename matches counts. So a second pane in the
wezbridge cwd is indistinguishable to the watchdog from the real one, which makes it a perfect
stand-in. Killing the live pane-0 instead would (a) silently kill the fleet Monitors that are the
current watch layer, (b) leave the recovered session unaware it must re-arm them, and (c) make the
subject grade its own resurrection.

## Preconditions

- Operator present (a partial recovery must be caught immediately).
- Daemon running from main with the watchdog armed — confirm in its shell pane:
  `pane0-watchdog armed (30s check, 90s absent-recovery, 10min cooldown, 3-strike disable)`.
- The real pane-0 is the GRADER and stays alive throughout; it must **not** be the only wezbridge
  pane at kill time (that is the whole point).

## Procedure

1. **Grader baseline** (real pane-0): note `pane0-watchdog` health and the current wezbridge beacon
   timestamp in `_intel/pane-events.jsonl`.
2. **Spawn the sacrificial pane** in the wezbridge cwd (`spawn_session`, agent `claude`). Let it
   reach its prompt; it counts as an orchestrator pane from this moment.
3. **Silence the real pane-0's beacons for the window** — this is the one subtlety: the watchdog
   fires on *no wezbridge beacon* + *no wezbridge pane*. The real pane-0 emits a beacon at every
   turn-end, so the grader must stay quiet (no turns) for the ~2-minute window, OR set
   `WEZBRIDGE_ORCH_REPO` to a dedicated marker repo for the test and spawn the sacrificial pane in
   that cwd instead. **Preferred: the marker-repo variant** — it isolates the test completely and
   leaves the real orchestrator free to grade in real time.
4. **Clean exit** of the sacrificial pane: type `exit` in its shell (never WezTerm kill-pane or the
   X button — the close-crash family, issues #6094/#2304/#6190/#5882).
5. **Timestamp T0** = the moment the pane disappears (`discover_sessions` no longer lists it).
6. **Wait, watching**: the daemon's shell pane logs recovery activity; `discover_sessions` shows the
   new pane appearing.
7. **Timestamp T1** = new orchestrator pane present AND its first beacon lands in
   `pane-events.jsonl`.

## Acceptance criteria

| Criterion | Evidence |
|---|---|
| Recovery fired without operator action | daemon log + new pane in `discover_sessions` |
| T1 − T0 ≤ 120 s | the two timestamps, recorded by the grader |
| Session resumed with context | recovered pane shows prior conversation (`--continue` worked) |
| Autoload returned | orchestrator-autoload injected dashboard + threads at SessionStart |
| No respawn loop | exactly ONE recovery attempt; cooldown honored afterwards |
| Monitors caveat documented | recovered sessions do **not** auto-re-arm Monitors — expected, and the reason the live orchestrator is never the subject |

## Known limits

- The watchdog restores a *session*, not a *watch posture*: Monitors and ScheduleWakeups do not
  survive. Any real pane-0 recovery needs a follow-up re-arm — a candidate for the kernel to own
  (post-pilot), since the reasoning pane cannot re-arm what it does not know it lost.
- `--continue` picks the most recent session for that cwd; with several wezbridge sessions in play,
  confirm which one resumed before declaring context restored.

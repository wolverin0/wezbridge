# T-0554: task_router resolves terminal from the live lane roster

Covers: scripts/orchestration/task_router.py terminal resolution for --from-card.
Key terms: resolve_roster_terminal, _legacy_terminal_for_repo, orchestrators.json, lane roster.
Read when: task_router picks the wrong (dead) terminal handle for a card's repo, or a new
lane/repo isn't being routed to its live pane.

## Problem
`task_router.py` had a hand-written `WORKER_REGISTRY` (~L20-58) with stale `default_term_id`
handles for pedrito and yolo26, and no entry for wezbridge itself. `--from-card` without an
explicit `--terminal` fell straight to the `"<TERMINAL_ID>"` placeholder instead of consulting
the live roster at `_intel/orchestrators.json` (already read by `src/lane-roster.cjs` for
`bridge_health`).

## Fix
Added `resolve_roster_terminal(repo, intel=None)`, which mirrors `lane-roster.cjs`'s
`loadRoster` semantics in Python: read `_intel/orchestrators.json` (via the existing
`intel_dir()` helper), find the lane whose `repos` contains the card's repo, return its
`handle`. Missing file, bad JSON, no `lanes` list, or no matching lane all degrade to `None`
without raising.

`build_from_card`'s terminal resolution for claude-runtime cards is now:
`explicit --terminal` -> `resolve_roster_terminal(repo)` -> `_legacy_terminal_for_repo(repo)`
(the old `WORKER_REGISTRY`, kept as-is) -> the `"<TERMINAL_ID>"` placeholder.

## Tests
`scripts/orchestration/test_task_router_from_card.py` gained three cases (roster hit, roster
file missing, roster file malformed — both non-hit cases fall back to the legacy registry via
a `pedrito` fixture card). Verified by temporarily forcing `resolve_roster_terminal` to always
return `None`: the new roster-hit test failed as expected, confirming it actually exercises the
roster path (reverted before commit).

`python -m pytest scripts/orchestration/test_task_router_from_card.py -q` → 8 passed (5
pre-existing + 3 new).

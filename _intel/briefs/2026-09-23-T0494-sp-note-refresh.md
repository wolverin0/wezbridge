# T-0494 SP note blocker refresh (brief)

Covers: sp-bridge.cjs writes operator-gated blocker into SP task note only at
creation; later syncs never refresh it, so 4/20 open operator tasks showed a
superseded blocker (T-0480, T-0472, T-0420, T-0346) as of 2026-09-20.
Key terms: blocker refresh, appendNoteOnce, map[ext].notesAppended, check-notes
detector. Read when: touching sp-bridge.cjs note-building/sync logic.

## Problem
scripts/sp-bridge.cjs writes the operator-gated card's question (blocker) into
the SP task note only at creation; later syncs never refresh it. Measured
2026-09-20: 4 of 20 open operator tasks showed a superseded blocker (T-0480,
T-0472, T-0420, T-0346). Evidence:
`_intel/evidence/wezbridge/2026-09-20-pregunta-congelada-en-sp.md`.
The note also accumulates lines via appendNoteOnce (state, result link, /act
links) tracked in map[ext].notesAppended — a refresh must not destroy those.

## Acceptance criteria (card, binding)
1. FAIL-FIRST: fixture ledger where the card already has a map.json entry and
   its blocker changed after createdAt; after sync the SP note contains the
   NEW blocker. RED on origin/main (paste), green after. Commit test before
   fix.
2. Idempotency in the same test: two consecutive syncs WITHOUT blocker change
   neither add nor lose any line (including the appendNoteOnce lines: state,
   result, /act links). Assert note length and map[ext].notesAppended equal
   before/after. Design the note so the blocker section is replaceable (e.g.
   a delimited head block or a `blocker-v<hash>` key) without rewriting the
   appended history.
3. Live path — READ-ONLY instead: no live sync. Compute against live
   map.json + ledger (read-only, or a scratch COPY with the fake client)
   which open fleet: entries currently have a stale blocker vs their card,
   list them (card id, note head vs blocker head, truncated). The real
   refresh happens at the first scheduled sync after merge; give the exact
   read-back command (client.getTasks() or map.json/notes check) for Fleet
   to run post-merge.
4. Detector: a check (script or `sp-bridge.cjs check-notes`) that walks open
   fleet: entries of map.json and FAILS naming each card whose note head
   differs from its card's blocker. Show it RED against the live state
   (read-only; it only reads) and GREEN on the fixed fixture.
5. `node --require ./test/setup.cjs --test test/*sp-bridge*.test.cjs` pass;
   `npm test` counts (known pre-existing failures: model-tiers ENOENT in
   worktrees, lane-hooks p95, daemon-cli, pretool-guardrail-jev,
   userprompt-routing-jev timing, mcp-server timeouts, tasks-watcher).
   Mutation: remove the refresh → AC1 fails.

## Constraints
Minimal diff; T-0495 (same file, /act buttons) follows — keep the note
structure change compatible with removing act links later. Commits
`test(sp-bridge): ...` then `fix(sp-bridge): ...`, ending with
`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. No push, no merge.

## Hard safety
Never run sync-decisions or anything that writes to the LIVE Super
Productivity / operator task list or the real `_intel/.sp-bridge/*`. Tests
use fixture ledgers + a fake SP client in temp dirs. Read-only inspection of
live `G:/_OneDrive/OneDrive/Desktop/Py Apps/_intel/.sp-bridge/map.json` and
`_intel/tasks/*.json` is fine.

# T-0350 — Record type=result on failed delivery (old A2A queue path)

Covers: `_intel/queues/<proj>.jsonl` drain, `src/project-queue.cjs`, `scripts/queue-drain.cjs`,
`src/a2a-intel.cjs`, `src/result-linker.cjs`, `scripts/result-link.cjs`. Bug: a queued
`type=result` envelope is only appended to `_intel/a2a-results.jsonl` on a SUCCESSFUL
classifyDelivery; failed-delivery results are silently lost or, historically, re-enqueued
up to 151x (envelope 996509539944f94d, memorymaster). T-0524 (Foreman queue) is a separate
newer path and out of scope. Read when: touching a2a-results recording, queue-drain retry
logic, or investigating missing/duplicate result records.

## Problem
A `type=result` envelope queued in `_intel/queues/<proj>.jsonl` is only recorded into
`_intel/a2a-results.jsonl` as part of a SUCCESSFUL drain. If classifyDelivery doesn't
verify, the line stays in the queue and no turn ever sees it. Also the opposite half: a
failed result was re-enqueued 151 times (~every 15 min, 2026-09-02T01:56Z →
2026-09-03T15:53Z, envelope id 996509539944f94d, memorymaster, corr
eve-piloto-d006-final-20260829) and landed 151 times in a2a-results.jsonl, then stopped for
an unknown reason. Relevant code (find the exact paths yourself): src/project-queue.cjs,
scripts/queue-drain.cjs, src/a2a-intel.cjs, src/result-linker.cjs, src/mcp-server.cjs
(a2a_send enqueue), scripts/result-link.cjs, fleet-steward result.unlinked. Note: T-0524
(Foreman queue) already covers the NEW path; this card is the old A2A queue path.
a2a-results.jsonl currently indexes by corr, not id.

## Acceptance criteria (card, binding)
1. Measure first, read-only: count type=result entries in
   `G:/_OneDrive/OneDrive/Desktop/Py Apps/_intel/queues/*.jsonl` absent from
   `_intel/a2a-results.jsonl` (by corr, and by id if available). Baseline from 2026-09-04:
   357 queued, 15 missing. Don't use ok=false as a failure proxy. Also count duplicate
   lines per id in a2a-results.jsonl.
2. Fail-first test: a queued result whose delivery fails (classifyDelivery not verified) IS
   recorded in a2a-results.jsonl with id, corr and body. Paste the RED against origin/main;
   commit the test before the fix.
3. Recording does not depend on card state: result whose corr points to a card in review is
   recorded and findable by corr.
4. No double record: a delivered result already carrying recorded:true doesn't write a
   second line; same test run as AC2. The same id can never write two lines.
5. Bounded retry: a result whose delivery fails is retried a BOUNDED number of times, then
   goes to dead-letter (test). Find out WHY the 151-times loop stopped on
   2026-09-03T15:53Z (git log/blame around that date on the drain/queue code, poller
   restarts, queue-state files) and report the answer with evidence — if it stopped only by
   restart, say so.
6. Backfill / duplicate cleanup of the LIVE _intel — NON-DESTRUCTIVE ONLY. Do NOT rewrite,
   truncate or delete lines from the real a2a-results.jsonl or queue files (data deletion is
   an operator gate). Allowed: (a) write a backfill SCRIPT (with --dry-run default) that
   APPENDS the missing results (idempotent by id) and run it ONLY in --dry-run against the
   live _intel, pasting what it would append; (b) make readers dedupe by id so the
   historical 150 duplicates are harmless, and show the re-run
   count-of-duplicates-as-seen-by-readers = 0 against a scratch COPY. Actual live append is
   left for the orchestrator to authorize — say exactly the command.
7. Tests: `node --require ./test/setup.cjs --test` on touched test files pass; `npm test`
   counts (known pre-existing: model-tiers ENOENT in worktrees, lane-hooks p95, daemon-cli,
   pretool-guardrail-jev, mcp-server T-0281/input-caps, tasks-watcher timeout). Mutation
   check for AC2 and AC4.

## Constraints
Minimal diffs; grep callers before changing exported functions. Tests use isolated temp
intel dirs (WEZBRIDGE_INTEL_DIR) — never write the real _intel. Don't restart the daemon.
Commits `test(queue): ...` then `fix(queue): ...` (+ `feat(queue): backfill script`), each
ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. No push, no merge. If
the card turns out larger than one sensible PR, deliver AC1-AC4 + AC5 and report AC6 as a
follow-up rather than cutting corners.

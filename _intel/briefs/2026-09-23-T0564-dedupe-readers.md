# T-0564 — Wire dedupeResultLines into a2a-results.jsonl readers + live backfill sizing

Covers: `src/a2a-intel.cjs` (dedupeResultLines, T-0350), `src/result-linker.cjs`,
`scripts/result-link.cjs`, `scripts/fleet-steward.cjs`, `scripts/daily-rollup.cjs`,
`scripts/backfill-a2a-results.cjs`. Bug: T-0350 left dedupeResultLines() exported
but unused; readers still count raw a2a-results.jsonl lines (157 corrs with >1
line; incident 996509539944f94d has 186 identical lines for one envelope), and
15 queued results were never recorded. Read when: touching a2a-results.jsonl
counting/summarizing, result-link cursor batching, or authorizing the live
backfill append.

## Problem
T-0350 added `dedupeResultLines()` (reader-side collapse keyed by `id`, or
`corr+sha1(body)` for legacy lines without `id`) but wired it into nothing.
Every production reader of `_intel/a2a-results.jsonl` still iterates the raw
file, so a resend-amplified envelope inflates whatever that reader counts.
Separately, T-0350's `scripts/backfill-a2a-results.cjs` (dry-run by default)
identifies ~15 `type=result` queue entries that were never recorded at all —
appending them is left for the orchestrator to authorize live.

## Acceptance criteria (card, binding)
1. Wire dedupeResultLines into the readers that actually count/aggregate raw
   lines: `scripts/daily-rollup.cjs` (summarizeResults: `total`/`v2`/`abandons`
   were raw `.length`+sums — the real bug), `src/result-linker.cjs` (new
   `parseResultLines()` batch helper) wired into `scripts/result-link.cjs`'s
   cursor consumer, and `scripts/fleet-steward.cjs` (`firstResultTimes`,
   defensive — investigate whether its existing corr-keyed min-time Map
   reduction is already immune before assuming a bug). Grep for other readers
   (board-app/server.cjs, src/mcp-server.cjs, scripts/fleet-drill*.cjs,
   scripts/backfill-a2a-results.cjs) and wire or justify each by its actual
   aggregation shape (Set/Map-keyed lookups are not vulnerable to raw-count
   inflation; `.length`/sum accumulators are).
2. Fail-first test per reader with a duplicate-envelope fixture (same `id`,
   different `time`, matching the 996509539944f94d resend shape), RED on
   origin/main where a real bug exists, asserting the fixed reader counts
   each distinct result once. Mutation check: removing the dedupe wire must
   turn the test red again.
3. Side-effect analysis BEFORE any live backfill: on a scratch COPY of the
   live `_intel` (never the real file/queues), run
   `node scripts/backfill-a2a-results.cjs <copy> --dry-run`, resolve each
   missing entry's corr to its card (if any) and current state, then actually
   append on the COPY and run the real linker (`src/result-linker.cjs` via the
   real `_docs-curation/ledger.cjs`, `WEZBRIDGE_INTEL_DIR` pointed at the
   copy) to see what it would do, diffing `tasks/*.json` before vs after.
   REQUIREMENT: no card in `done`/`cancelled` may change state — if the
   linker would move one, add/confirm a terminal-state guard (test it) and
   re-simulate before reporting clean.
4. Do NOT run `--live` on the real `_intel`. Report the exact live command
   and the expected before/after `a2a-results.jsonl` line counts so the
   orchestrator can authorize it separately.
5. `node --require ./test/setup.cjs --test` on touched test files passes;
   report `npm test` counts, noting pre-existing failures are unrelated
   (model-tiers ENOENT in worktrees, lane-hooks p95 timing, and other
   environment-dependent suites the brief names as known).

## Constraints
Minimal diffs; grep every caller of a modified exported function before
changing its signature. HARD SAFETY: never write the real
`_intel/a2a-results.jsonl` or `_intel/queues/*`; no `--live` backfill against
real `_intel` in this task — only scratch copies. Commits test-first then
fix (conventional), each ending
`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Push the branch,
open a PR against `main`, do not merge.

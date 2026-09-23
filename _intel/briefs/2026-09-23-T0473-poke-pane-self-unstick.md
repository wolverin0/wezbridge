# T-0473 — poke-pane self-unstick on FAIL(9) residue

Covers: scripts/poke-pane.cjs FAIL(9)/exit-10 composer-residue lock; task_id=T-0473;
tier=T3; branch fix/t0473-poke-pane-self-unstick. Read this before touching
poke-pane's composer-residue or ceiling logic — it is the binding card (AC1-6).

## Problem
scripts/poke-pane.cjs, on a delivery failure FAIL(9) (fragmented/truncated paste),
leaves its own partial payload in the target composer "for the operator". From then
on every poke to that pane dies BEFORE writing with exit 10: "composer already holds
unsent text - nothing written; a key from the operator unblocks it". Measured 15/09:
the only executor with credits sat 2h waiting for an operator keystroke at 3am. The
claim is FALSE: a single ctrl+c cleared the composer, verified composerContent()==''
after, session intact (Ctrl+U 0x15 is NOT bound). Related: scripts/composer-state.cjs,
src/verified-send.cjs, guards T-0242/T-0323 (foreign text in composer must never be
overwritten).

## Acceptance criteria (card, binding)
1. FAIL-FIRST REAL: test simulating a pane whose composer contains ONLY a fragment of
   the payload poke-pane just wrote; asserts the NEXT run delivers (not exit 10). Must
   fail on origin/main (paste RED) and pass after; commit the test before the fix.
2. The FAIL(9) path cleans its own residue before exiting and VERIFIES it
   (composerContent()=='' on re-read), and the error message says so. If cleanup can't
   be verified, exit with today's code and say so.
3. Cleanup never extends to text poke-pane can't prove it wrote: with FOREIGN text in
   the composer (T-0242/T-0323 guard, an open operator question) it still dies exit 10
   without writing. Tests for both sides. Decide how "proof it wrote it" works (e.g.
   composer content is a prefix/fragment of the exact payload of this run, or a marker
   recorded by the previous run) and justify.
4. exit 10 and FAIL(9) texts stop claiming "a key from the operator unblocks it" on the
   path that now self-cleans; grep of the source: 0 occurrences of that phrase on that
   path.
5. Explicit, measured payload ceiling: poke-pane declares its limit like a2a_send
   declares 900 chars (with an escape equivalent to allow_long); a test sends above the
   ceiling and asserts it WARNS instead of trying and breaking. Include the measured
   datapoints from 15/09 as test data: 433 OK, 1386 head lost, 3733 OK — i.e. the
   ceiling is NOT only length; don't pretend it is (document what the ceiling can and
   can't guarantee).
6. Touched test files pass with `node --require ./test/setup.cjs --test`; `npm test`
   counts (known pre-existing: model-tiers ENOENT in worktrees, lane-hooks p95,
   daemon-cli, pretool-guardrail-jev, mcp-server T-0281/input-caps/redaction timeouts,
   tasks-watcher timeout). Mutation: remove the self-clean → AC1 test fails; remove the
   ownership check → AC3 test fails.

## Constraints
Minimal diff; grep callers of anything exported. Commits `test(poke-pane): ...` then
`fix(poke-pane): ...`, each ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
No push, no merge. Don't touch the main checkout.

## Close format
[WORKER_DONE] task_id=T-0473 branch=<branch> commit=<sha>
criteria:
- AC1..AC6: pass|fail — evidence
files_changed: <list>
next_action: <...>

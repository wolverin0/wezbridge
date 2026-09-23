# T-0400: tests must invoke handlers, not grep source

Covers: 7 wezbridge tests (a2a-intel, a2a-length-guard, mux-single-id-space,
orch-ctx-check, poke-pane-one-prompt, smuggled-envelope, weak-passes) that
proved wiring by grepping src/*.cjs text instead of calling the handler —
same class of hole as T-0307. Key terms: mcp-call helper, if(false) mutation,
RED/green evidence, constants tripwire. Read when: touching these test
files or adding new MCP-server-invoking tests.

## Problem
Seven wezbridge tests "prove" a handler's wiring by GREPPING the source of src/*.cjs (same class as T-0307): wrapping the protected block in `if (false) { ... }` leaves them green while the code is dead. Goal: each such test invokes the handler for real (MCP server spawned in-test with the wezterm mock + reusable callTool helper), or is explicitly labeled a constants tripwire; and an `if (false)` mutation of the protected block turns at least one test RED in each file.

## Acceptance criteria (card, binding)
1. Shared helper `test/helpers/mcp-call.cjs` (spawn src/mcp-server.cjs + JSON-RPC over stdio + temporary WEZBRIDGE_INTEL_DIR), extracted from test/a2a-send-spills-before-refusing* and test/mcp-server-v35-tools* WITHOUT changing their behavior (they switch to the helper and stay green).
2. Per file, `if (false)` mutation on the block the test claims to protect, RED output pasted: a2a-intel (3 sites: recordResultBody, detectDecisions/detectEvidence, autoAck), a2a-length-guard (guard ordered before send), mux-single-id-space (spawnPane/splitHorizontal via wezCmd), orch-ctx-check (runCtxCheck in orchestrator-turn), poke-pane-one-prompt (fragmented dies with 9), smuggled-envelope (send_prompt blocks and audits), weak-passes (UNVERIFIABLE PASSES). Show for each: original test green on origin/main, green after your rewrite, RED under mutation, then mutation reverted. Find the exact test file names with `ls test | grep`.
3. The 3 that do NOT have the hole get a header comment stating what they are: poke-pane-submit-contract (constants tripwire), project-queue (negative setInterval assertion), tasks-watcher (atomicity tripwire).
4. `npm test` green except known pre-existing failures (model-tiers ENOENT in worktrees, lane-hooks p95, daemon-cli, pretool-guardrail-jev, mcp-server T-0281/input-caps/redaction timeouts, tasks-watcher timeout) — paste counts; `git status --porcelain` clean at the end (no leftover temp files / mutations).

## Constraints
Test-only changes plus the helper; do NOT modify src/ except if a handler is literally untestable without a tiny injectable seam — then stop and report instead of refactoring. Keep each rewritten test anchored on the requirement. Other open PRs touch test/a2a-intel.test.cjs (T-0350 adds tests at the end) and test/project-queue.test.cjs — keep your edits to those files localized (edit existing tests in place, don't reorder the file) to minimize conflicts. Commits per logical group, conventional `test(...)`, each ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. No push, no merge.

## Close format
[WORKER_DONE] task_id=T-0400 branch=<branch> commit=<sha>
criteria:
- AC1..AC4: pass|fail|partial — evidence (per-file mutation table for AC2)
files_changed: <list>
next_action: <...>

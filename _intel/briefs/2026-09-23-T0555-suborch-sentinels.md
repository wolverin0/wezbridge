<!--
DOC-HEAD: Brief for T-0555 (Tier-3 worker task). Covers: orca-census.cjs and
foreman.py sentinel recognition for lane-orchestrator report lines
(SUBORCH_DONE/QUESTION/STATUS/HANDOFF) in addition to WORKER_DONE, durable
event append to _intel/pane-events.jsonl, echo-filter extension, foreman.py
--sentinel suborch flag + notify_orchestrator forwarding, and test/smoke
requirements. Read this before touching src/orca-census.cjs or
scripts/orchestration/foreman.py sentinel-matching logic.
-->

task_id=T-0555 tier=T3. Repo: wezbridge. FIRST: your worktree may be based on a stale branch — run `git fetch origin && git checkout -b fix/t0555-suborch-sentinels origin/main` inside your worktree so you start from origin/main (7694bb2 or newer). The orchestrator has no Write tool: STEP 0 save this brief verbatim (with a 7-line doc-head) to `_intel/briefs/2026-09-23-T0555-suborch-sentinels.md` and commit it with your change.

## Problem
Lane orchestrators report with four pane lines:
- `[SUBORCH_DONE] task_id=T-NNNN outcome=succeeded|failed report=<path>`
- `[SUBORCH_QUESTION] task_id=T-NNNN q='<question with options a/b/c>'`
- `[SUBORCH_STATUS] lane=<x> running=<ids> done=<ids> blocked=<ids> next=<id>` (free-form key=value)
- `[SUBORCH_HANDOFF] <path>`
But `src/orca-census.cjs` (SENTINEL_RE line ~37, ECHO_MARKERS ~38, scan loop ~234, append to `_intel/pane-events.jsonl` ~281, dedupe) and `scripts/orchestration/foreman.py` (SENTINEL_RE ~94, ECHO_MARKERS ~96, notify_orchestrator ~82 → notify_orchestrator.py, outbox `_intel/foreman/outbox.jsonl`) only recognize `[WORKER_DONE]`. Lane reports never reach Fleet durably; Fleet reads panes by hand.

## Acceptance criteria
1. orca-census.cjs: recognize all 4 SUBORCH types in addition to WORKER_DONE (don't break WORKER_DONE). Append a durable event per NEW line to the SAME events file the census already uses (the card says "events.jsonl"; the code uses pane-events.jsonl — use the existing file, report which) with `event`/`kind` = `suborch_done|suborch_question|suborch_status|suborch_handoff`, plus parsed fields (task_id, outcome, report, q, path, or raw kv for status), terminal/repo, line. Dedupe like the existing path (a STATUS line repeated across polls must not append twice; two different STATUS lines must both append).
2. Echo filter kept and extended: brief/instruction text must NOT produce events. Placeholders like `task_id=T-NNNN`, `report=<path>`, `q='<question...'`, `outcome=succeeded|failed` (literal alternation), `running=<ids>` are echoes. Test fixture: a screen containing the 4 real lines + echo lines copied from a brief → exactly 4 events.
3. foreman.py: accept `--sentinel suborch` (or detect both) and close a task on a real `[SUBORCH_DONE]` line; unit test. `[SUBORCH_QUESTION]` is forwarded via notify_orchestrator so it lands in `_intel/foreman/outbox.jsonl` (test with the outbox redirected to a temp dir — never write to the real _intel in tests).
4. Smoke: run the census poll function once against a fixture snapshot with an isolated intel dir and show the appended events. Then check whether the LIVE daemon (:4200) runs the orca-census poller from this code; do NOT restart the daemon or touch the main checkout (it's on another branch with foreign uncommitted changes). If a live smoke needs a daemon restart on new code, mark AC as "pending post-merge" and say exactly what command would prove it.
5. Tests: `node --test` on touched/new test files + the python tests for foreman (find existing ones under scripts/orchestration or test/) pass; run `npm test` and report counts (known timing flakes: lane-hooks p95, daemon-cli, pretool-guardrail-jev, mcp-server T-0281 AC3/AC4 pre-existing on main). Mutation check: disable the new SUBORCH match and confirm tests fail.

## Constraints
Minimal diffs, no rewrites. Check callers before changing exported symbols (grep; gitnexus_impact if available). Commit on fix/t0555-suborch-sentinels with conventional commit `feat(census): ...` ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not push, do not merge.

## Close format
[WORKER_DONE] task_id=T-0555 branch=<branch> commit=<sha>
criteria:
- AC1..AC5: pass|fail|pending — evidence
files_changed: <list>
next_action: <...>

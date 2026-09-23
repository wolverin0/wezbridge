# T-0526 — Sentinel fallback channel when no orchestrator pane found

Covers: daemon-heartbeat-sentinel.cjs must fall back to ntfy/Telegram when deliverPoke() fails
(delivered:false, 157/199 alerts since 22/08 lost, 70h undetected downtime in Sept).
Key terms: fallback, deliverPoke, ntfy-notifier, telegram-streamer, episode cooldown, deadman_touch.
When to read: any future change to sentinel alert delivery / fallback channel logic.
Tier: T3. Repo: wezbridge. Branch: worktree-agent-aec9db5128c5f672d (off orch/tracks-ledger-20260830).
AC1-7 below define done; see close format at bottom.

---

task_id=T-0526 tier=T3. Repo: wezbridge (you are in an isolated worktree off branch orch/tracks-ledger-20260830). The orchestrator has no Write tool, so STEP 0: save this brief verbatim to `_intel/briefs/2026-09-23-T0526-sentinel-fallback.md` in the worktree (with a 7-line doc-head summary) and include it in your commit.

## Problem (root cause known)
`scripts/daemon-heartbeat-sentinel.cjs` (Windows scheduled task WezBridge-DaemonSentinel, every 5 min) delivers DAEMON DOWN/WEDGED alerts ONLY via `deliverPoke()` to an orchestrator pane. 157 of 199 alerts since 22/08 logged `delivered:false` ("no orchestrator pane found") → 70 h of daemon downtime in September went unnoticed. Existing out-of-band channels in repo: `src/ntfy-notifier.cjs` (`notify({title,message,priority,tags})`, env NTFY_TOPIC/NTFY_SERVER/NTFY_TOKEN, `isEnabled()`) and Telegram (`src/telegram-streamer.cjs` reads TELEGRAM_BOT_TOKEN/TELEGRAM_GROUP_ID from env or an .env file — see lines ~58-84 for how it loads them; reuse that resolution, don't duplicate secrets). Sentinel must depend on nothing the daemon owns.

## Acceptance criteria
1. When an alert run ends with `delivery.delivered !== true` (no pane, refused, or thrown), the sentinel sends the same message via ntfy (if enabled) and/or Telegram sendMessage (if configured) IN THE SAME RUN. Record result in the jsonl log line as `fallback: {channel, ok, error?}`. Never print tokens.
2. If neither channel is configured, log `fallback: {ok:false, reason:'no fallback channel configured'}` and exit non-zero (loud, not silent). Determine and REPORT (don't guess) which env/config the scheduled task actually sees: check `schtasks /query /tn WezBridge-DaemonSentinel /v /fo LIST` for the command/wrapper, and whether NTFY_TOPIC or the Telegram vars resolve in that context. Do NOT create/modify credentials or scheduled tasks; if no channel resolves, say so in the report — that's an operator gate.
3. Fallback respects the existing episode cooldown (first alert + 30-min re-poke), no per-5-min spam. Fallback send must have a timeout (≤8 s) and must never crash the sentinel.
4. Unit tests in `test/daemon-heartbeat-sentinel.test.cjs` (or a new test file): (a) delivered:false → fallback called with the message; (b) delivered:true → fallback NOT called; (c) no channel → logged reason + non-zero. Anchor tests on the requirement (a test must fail if the fallback call is removed). Inject the sender; no real network in tests.
5. Drill (controlled, do NOT kill the real :4200 daemon): run the sentinel main path with a dead probe target / isolated WEZBRIDGE_INTEL_DIR tempdir such that verdict is down and no pane is found, and show the real fallback delivery result (HTTP status from ntfy/Telegram) if a channel is configured. Paste command + output.
6. Also expose `deadman_touch` (contents of `_intel/evidence/wezbridge/deadman-touch.json`) and the last fallback result in the bridge_health response IF it's a small change in the file that builds bridge_health (find it; note src/mcp-server.cjs has uncommitted foreign changes in the main checkout — your worktree is clean, touch only what you need). If it's more than ~15 lines, skip and say so.
7. `node --test` for the touched test files passes; also run `npm test` and report counts (one known flaky: lane-hooks latency p95).

## Constraints
- Minimal diffs, no rewrites. Before editing a function, check callers (grep or gitnexus_impact if available).
- Commit on your worktree branch with conventional commit `fix(sentinel): ...` ending with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not push, do not merge.

## Close format (your final message)
[WORKER_DONE] task_id=T-0526 branch=<branch> commit=<sha>
criteria:
- AC1: pass|fail — evidence
- ... AC7
files_changed: <list>
next_action: <what remains, e.g. AC3 7-day observation, operator config gate>

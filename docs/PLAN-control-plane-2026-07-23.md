# PLAN — Fleet Control Plane build (enforced, not hoped)
Turns the 2026-07-23 graph-orchestration review into code: A2A envelope v2 ENFORCED at 3 layers (wezbridge server validation + events.jsonl audit; Claude/Codex lifecycle hooks; ledger state), then task ledger + FSM + edges. Phase C sweeper (shipped) is node 1.
Key terms: envelope-v2, a2a-protocol-inject hook, a2a-thread-gate Stop hook, events.jsonl, _intel/tasks FSM, leases, edges.json, /orchestrate.
Read when: building/resuming any control-plane phase, or auditing why a protocol rule is enforced where it is.
Status: Phase 1 FULLY DONE (1.3 codex hooks landed 2026-07-27 — same scripts, registered in ~/.codex/hooks.json); Phase 2 done. Companion visuals: artifacts/2026-07-23-fleet-control-plane-graph.html (mechanics) + -graph-orchestration-review.html (verdict).
Principle (operator-set): CLAUDE.md prose is hope; a rule exists only if something deterministic fails when it's violated. LLM keeps judgment; code keeps protocol.
Owner: wezbridge orchestrator pane. Operator gates: editing ~/.claude/settings.json hooks (approved 2026-07-23), codex hooks install, any hard-reject rollout.

## Enforcement-by-ownership map (why each rule lives where it lives)

| Rule | Layer | Why there |
|---|---|---|
| v2 result shape (criteria/evidence) | wezbridge server (a2a_send) | Transport is ours; validates with zero model cooperation |
| Every envelope audited | server → `_intel/events.jsonl` | Ledger fills itself; no LLM in the loop |
| Protocol arrives WITH the message | UserPromptSubmit hook (inject) | Beats context rot: recency > primacy; fires per envelope |
| No stop with open A2A thread | Stop hook (gate) | Only the session lifecycle knows "about to stop"; proven blocker (MM checkpoints) |
| Ack every result | server open-thread tracking + hook nag | Codex re-send loops die at the source |
| Progress cadence / stalls | Phase 3: heartbeat + lease expiry | Deterministic timers, not memory |
| Work quality / judgment | LLM (panes) | Not hookable — by design |

## Phase 1 — Enforced protocol (CODE) — in progress

- [x] 1.0 This plan file + HTML graph updated with enforcement layer.
- [x] 1.1 DONE 2026-07-23 — `src/a2a-intel.cjs` (detectV2, recordEvent, updateThreads) wired into a2a_send; 294 tests / 0 fail (8 new). Rollout: per-pane MCP restart.
- [x] 1.2 DONE 2026-07-23 — both hooks written, lifecycle-verified by stdin simulation (block→fulfill→allow→ack-owed→cap), registered in settings.json (valid JSON confirmed). Hooks active for NEW Claude sessions.
- [x] 1.4 DONE 2026-07-23 — a2a-protocol.md v2 section + enforcement table; global CLAUDE.md (v2 note + Knowledge Compiler section); ~/.codex/AGENTS.md (v2 + knowledge compiler).
- [ ] 1.1-original spec for reference: **wezbridge server** (`src/mcp-server.cjs`, rollout = each pane's next MCP restart, like the truncation fix):
  - a2a_send `type=result`: detect v2 block in body (criteria/evidence markers). Response gains `v2: ok|missing`. WARN-only first (30+ live panes); hard-reject is a later operator call.
  - Append EVERY sent envelope (meta only: from,to,corr,type,v2,delivered,ts — never full body) to `Py Apps/_intel/events.jsonl` (resolve via `WEZBRIDGE_INTEL_DIR` || `<wezbridge>/../_intel`). Fail-soft: never break send on audit-write failure.
  - Maintain `_intel/a2a-threads.json`: request opens corr; result marks awaiting-ack; ack closes. Response notes when the CALLER has unacked inbound results (kills codex re-send loops at source).
  - Verify: `node --test test/*.test.cjs` green + new cases for v2 detect + threads state; live round-trip against a real pane.
- [ ] 1.2 **Claude hooks** (global, `~/.claude/hooks/`):
  - `a2a-protocol-inject.cjs` (UserPromptSubmit): regex `^\[A2A from pane-\d+ to pane-\d+ \| corr=`. On request: record open corr in `~/.claude/hooks/state/a2a-<session_id>.json`; inject contract (ack fast, progress ~3min, MUST end with type=result on corr, v2 fields). On result-received: inject "ack immediately". Fail-soft, <50ms, no deps.
  - `a2a-thread-gate.cjs` (Stop): open corrs for this session? scan transcript tail for `type=result` + corr via a2a_send; close matched. Unmatched → BLOCK stop with instruction. Max 2 blocks per corr then warn-only (no infinite loops).
  - Register both in `~/.claude/settings.json`. Verify: simulate stdin JSON for both hooks + live envelope test.
- [x] 1.3 DONE 2026-07-27 — **Codex hooks**: codex's hooks.json system (`~/.codex/hooks.json`, same schema + stdin payload keys as Claude's settings.json — confirmed via skill-run-capture-core which serves both) lets us register the SAME scripts, zero porting: pane-beacon.cjs under Stop (transcript delta scan is format-agnostic, works on rollout-*.jsonl) + a2a-protocol-inject.cjs under UserPromptSubmit. Pipe-tested with codex-shaped payloads: beacon emitted turn-end w/ GATE marker AND flowed through the live v7 Monitor filter end-to-end; inject emitted the full v2+GATE contract. NOTE: codex `notify` slot is owned by the desktop computer-use runtime — do NOT touch it (docs confirm: single program, agent-turn-complete only). DOC-VERIFIED (learn.chatgpt.com/docs/hooks, 2026-07-27): event names/casing ✓, stdin payload fields ✓, hookSpecificOutput.additionalContext IS supported ("extra developer context") ✓, Stop CAN block (decision:"block" → continuation prompt) ✓, trust via /hooks command (hash-recorded) ✓, timeouts in seconds ✓. → a2a-thread-gate.cjs ALSO registered under codex Stop; its evidence matcher now accepts both serializations (Claude nested-JSON `"corr":"x"` AND codex escaped-string `\"corr\":\"x\"`), pipe-tested three ways (escaped-fulfilled no-block / unfulfilled block / plain-fulfilled no-block). Remaining caveat: operator must trust the three new hooks.json entries via /hooks on next codex session; first live codex pane doubles as the injection field-test. Repo-level `.codex/hooks.json` also exists per docs — future per-repo contract hooks can ride there.
- [ ] 1.4 **Docs describe the code** (not vice versa): `docs/a2a-protocol.md` v2 section; wezbridge CLAUDE.md; global CLAUDE.md gets the knowledge-compiler paragraph (corrections recurring 2× MUST become enforcement artifacts; MM claim = fallback).

## Phase 2 — Ledger (durable state)

STATUS: 2.1-2.4 BUILT+VERIFIED 2026-07-23 (same session as Phase 1): ledger.cjs full FSM/lease/dashboard lifecycle exercised incl. failure paths (illegal transition rejected, lease conflict rejected); sweeper auto-created T-0002 from the real whatsappbot flag and re-sweep proved dedupe (0 duplicates); dashboard.md now ledger-owned (tasks+flags one view); edges.json v1 (4 rules); /orchestrate skill installed; /intel-refresh updated to dispatch via ledger. PENDING: the acceptance test (fresh session resumes fleet from files in ≤2 min) runs naturally at next orchestrator session start — do it then, record result here.

- [x] 2.1 `_docs-curation/ledger.cjs` — deterministic lib + CLI (`create|update|lease|release|list|dashboard`). Tasks: `_intel/tasks/T-NNNN.json` {id,title,goal,state,owner_pane,lease{owner,expires_at},acceptance_criteria[],context_refs[],corr,attempt,updated_at}. FSM: queued→ready→running→review→done (+blocked/failed/cancelled). Leases expire; expired = reclaimable.
- [ ] 2.2 Sweeper integration: flags auto-create/refresh ledger tasks (dedupe by repo+kind); `dashboard.md` regenerated from tasks+flags in one place (ledger.cjs `dashboard`, called by sweeper).
- [ ] 2.3 `/orchestrate` skill: on start read dashboard+flags+open tasks → dispatch/resume with v2 envelopes, corr = task id. `/intel-refresh` updated to create tasks instead of ad-hoc dispatch.
- [ ] 2.4 `edges.json` v1: `on-done(kind) → dispatch(kind→target, gate?)`. v1 executor = orchestrator session reading rules (LLM reads, file stores). Acceptance test for Phase 2: kill orchestrator mid-task → fresh session resumes from files alone in ≤2 min.

## Phase 3 — Watchers (build only after ledger has ~1 week of traffic)

- [ ] Lease-expiry → deterministic poke (sweeper tick or :4200 daemon). Heartbeat (`a2a-heartbeat.cjs`) keyed to open corrs. P0-blocked-past-deadline → Telegram. Unattended edge-rule daemon (maybe). NOT NOW.

## Hard rules carried forward
- Sweeper/ledger/hooks stay deterministic — no LLM calls inside; no git hooks ever (plague); all local (operator constraint: no cloud routines).
- Server changes fail-soft: protocol enforcement must never break message delivery.
- Rollout honesty: v2 starts WARN-only; panes upgrade on MCP restart; don't claim fleet-wide enforcement until `bridge_health`-style verification shows it.

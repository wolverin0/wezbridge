# PLAN — Fleet Control Plane build (enforced, not hoped)
Turns the 2026-07-23 graph-orchestration review into code: A2A envelope v2 ENFORCED at 3 layers (wezbridge server validation + events.jsonl audit; Claude/Codex lifecycle hooks; ledger state), then task ledger + FSM + edges, then ROADMAP.md ingestion so the orchestrator prompts agents from each project's own pending-work file instead of only from ledger-created tasks.
Key terms: envelope-v2, a2a-protocol-inject hook, a2a-thread-gate Stop hook, events.jsonl, _intel/tasks FSM, leases, edges.json, /orchestrate, ROADMAP.md convention, origin_key, repos.json, kinds.json, drift linter.
Read when: building/resuming any control-plane phase, auditing why a protocol rule is enforced where it is, or wiring a project's roadmap into the dispatch loop.
Status: Phases 1+2 FULLY DONE — Phase 2 acceptance test PASSED 2026-07-30 on its first run (fresh session resumed fleet from files in 83s vs the 120s bar). **Phase R: R.1+R.2 (registries, commit f096a28 tests) + R.4 (drift linter, 2d5c5ca) + R.3 (importer, caddbef) built and green 2026-07-30; R.5 pilot PENDING — mutual dry-run shows 10 items, needs section curation + declared A2A to pane-37 before --apply.** Companion visuals: artifacts/2026-07-23-fleet-control-plane-graph.html (mechanics), -graph-orchestration-review.html (verdict), 2026-07-29-roadmap-convention-survey.html (convention + migration table + risks), 2026-07-30-orchestration-system-review.html (flaws F1-F8).
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

## Phase R — Roadmap ingestion (added 2026-07-29; the layer this plan was missing)

WHY THIS EXISTS: Phases 1-2 gate and track tasks *created through the ledger* — roughly 20% of fleet
output. Everything else arrives as a direct prompt and touches no gate. The operator's requirement,
verbatim: "we should have 1 roadmap file per project, and the orchestration should be you, running
the roadmap ... YOU are the one that PROMPTS the agents." This phase closes that gap. It is the
ONLY thing between the current state and that loop — `contractFor()` already gates, `dispatchable()`
already selects, leases already prevent double-work, the steward already catches stalls.

CONVENTION (decided 2026-07-29 by measured survey — 137 roadmap files, ~32 projects, 1966 open items;
full reasoning + per-project migration table + 12 risks in `artifacts/2026-07-29-roadmap-convention-survey.html`):
`<repo_root>/ROADMAP.md`, open items marked `- [ ] `, closed `- [x] `. Chosen because 48 files already
use that name and this FS is case-insensitive with `core.ignorecase=true`, so it costs ZERO renames.
Machine fields ride an additive pipe grammar (`- [ ] T-0031 | kind=write-rpc | owns=app/** | title`)
so all 1966 legacy items keep parsing. Section-level `{kind=...}` inheritance makes tagging affordable.
LAYERING: the markdown owns INTENT (what exists, document order = priority); `_intel/tasks/T-NNNN.json`
keeps owning RUNTIME state (lease/attempt/FSM/evidence). One writer per field.

- [x] R.1 DONE 2026-07-30 — `_intel/repos.json` written; worktree exclusion by GIT METADATA (rev-parse --git-dir), not name — clawtrol's own worktrees sit at top level and name-matching would have missed them. whatsappbot-final + clawtrol carry status pending_operator with the exact decision text. Enforced by 4 tests (wezbridge f096a28).
- [ ] R.1-original spec: `_intel/repos.json` — slug → absolute path + pane hint, EXCLUDING `_worktrees/**`.
  Non-negotiable and first: worktrees hold 45 duplicate roadmap files with 591 open items, so an
  orchestrator that GLOBS instead of reading a registry dispatches the same item ten times in parallel
  into trees that share a repo. Also fixes slugs that resolve to no top-level path.
  **Exit:** every repo slug in the existing ledger resolves to a directory that exists; zero paths
  under `_worktrees/`; a deliberate glob-vs-registry diff test shows the registry excluding the dupes.
- [x] R.2 DONE 2026-07-30 — `_intel/kinds.json`: 26 ledger kinds + 4 reserved, general=read_mostly, unknown→general AND flag, 7 fleet-minimum operator gates escalate-only. Enforced by tests (wezbridge f096a28).
- [ ] R.2-original spec: `_intel/kinds.json` — CLOSED kind vocabulary. Today: 26 distinct kinds across 43 tasks while
  `edges.json` has rules for 2 plus wildcards, so most items match no rule and the gate is DECORATIVE.
  Unknown slug resolves to `general` AND raises a flag — never honoured silently.
  **Exit:** every kind present in existing tasks is either listed or explicitly aliased; `general` maps
  to the SAFE read-mostly contract, proven by a test asserting an untagged item cannot get scoped_write.
- [x] R.3 DONE 2026-07-30 (build) — roadmap-import.cjs (_docs-curation caddbef): dry-run default, origin_key idempotency, write-back-then-dispatch, born-blocked gating at create (FSM forbids queued→blocked later), orphans reported never re-minted, non-active repos refused. 9 hermetic tests (wezbridge adc9f46). LIVE APPLY not yet run — that is R.5.
- [ ] R.3-original spec: Importer — read only `- [ ]` matched lines (never whole files: interonda has 610 closed items),
  allocate `T-NNNN`, WRITE THE ID BACK BEFORE DISPATCHING, then `create()` with `origin_key`.
  `origin_key` + `findByOrigin()` added to ledger.cjs 2026-07-29 and verified idempotent.
  **Exit:** run twice against mutual → identical task count, zero duplicates; a reworded title does not
  mint a second task.
- [x] R.4 DONE 2026-07-30 — roadmap-lint.cjs (_docs-curation 2d5c5ca), 11 hermetic tests (wezbridge 6aa22a3): done-no-trace / sha-not-landed / shipped-open / ledger-drift / no-ledger-row + format-blind guard (added after its own first live run produced a vacuous clean on whatsappbot’s table-format roadmap). Every verdict states its scope.
- [ ] R.4-original spec: Drift linter — NOT optional polish. Evidence: KB-12 in whatsappbot was marked COMPLETE while
  its 8 branches had zero PRs and no commits in main, and the work is customer-facing. If `- [x]` can
  be written without code landing, the importer inherits that falsehood across 1966 items.
  DRIFT RUNS BOTH WAYS — confirmed 2026-07-29 by the whatsappbot pane (PR #1121), which found SIX
  fixes committed with no PR, THREE of them corresponding to items still marked open in the same file.
  So checking only "marked done but not shipped" catches half the problem.
  Must FAIL when: (a) an item is `- [x]` but its ledger task is not done; (b) a marked-complete item's
  commits are not ancestors of main; (c) an open item has no ledger row; (d) REVERSE DRIFT — commits
  exist on a branch referencing an item id that is still `- [ ]`, i.e. work done and never claimed.
  **Exit:** run today against whatsappbot → FAILS on KB-12 (direction b) AND on the three
  committed-but-open items (direction d). Both cases are live fixtures; no synthetic test needed.
- [x] R.5 DONE 2026-07-30 — full pipeline ran: roadmap.md line 87 → T-0045 minted+written-back (10 tasks, 7 born-blocked incl. mutual's own write-rpc gate) → dispatched read_mostly (contract mode → plan-mode spawn = harness-enforced) → executor proposal returned as v2 result → verified → review, follow-ups T-0055/T-0056/T-0058 filed. Marker flip deliberately awaits merged work (linter enforces). Bugs found AND closed by the run itself: spawn submission verifier can report submitted on an eaten prompt (mutual's dangling auto-memory-hook, T-0055); create() bypassed fleet-minimum gates (fixed 063a0eb, probe-proven); kind vocabulary violation caught by own registry test (migration added). futura-command-center: 0 open items, nothing to import — drained canary confirmed. FREEZE BEGINS: one week operate-only from 2026-07-31.
- [ ] R.5-original spec: Pilot on TWO repos only — `mutual` (active ledger repo, 10 open items) and
  `futura-command-center` (0 open / 14 closed, already drained = zero-risk canary for write-back).
  NOT 32 projects on day one.
  **Exit:** orchestrator reads mutual's ROADMAP.md, dispatches one item with its gate honoured, the
  executor returns a v2 result, and the marker flips to `- [x]` with evidence appended — no human
  parsing at any step.

OPERATOR DECISIONS BLOCKING PARTS OF THIS (no script can make them):
- `whatsappbot-final` is the ledger's busiest repo (11 of 43 tasks) and its slug resolves to no
  top-level path — it sits inside a directory named "Copy - Copy". Automated writes there risk editing
  a backup while production diverges. Needed for R.1.
- `clawtrol` does not fit the convention: its items live in beads on a Dolt SQL server and T-0028's
  next_action already cites bead ids. Either the orchestrator special-cases it and queries beads, or
  its ROADMAP.md is an index that is NEVER the dispatch source. A mirrored file drifts within days.
- Duplicate top-level projects (`impulsa` has 5 roadmap files; `omniremote` vs
  `omniremote-phase1-wave2`). Project selection is the operator's — do not rank them.

AFTER R.5 PASSES: stop building and OPERATE for a week before touching Phase 3. The recorded core
diagnosis is a build/operate imbalance; this plan's own Phase 3 already encodes that discipline.

## Phase 3 — Watchers (build only after ledger has ~1 week of traffic)

- [ ] Lease-expiry → deterministic poke (sweeper tick or :4200 daemon). Heartbeat (`a2a-heartbeat.cjs`) keyed to open corrs. P0-blocked-past-deadline → Telegram. Unattended edge-rule daemon (maybe). NOT NOW.

## Hard rules carried forward
- Sweeper/ledger/hooks stay deterministic — no LLM calls inside; no git hooks ever (plague); all local (operator constraint: no cloud routines).
- Server changes fail-soft: protocol enforcement must never break message delivery.
- Rollout honesty: v2 starts WARN-only; panes upgrade on MCP restart; don't claim fleet-wide enforcement until `bridge_health`-style verification shows it.


<!-- doc-head: T-0421 one-lane; pinned errors must never enter automatic rescue queues -->
Operator directive replaces general graph activation with explicit project+pane -> durable receipt -> dispatch -> Jarvis evidence.
Read for the executable CLI, main adoption, proof artifacts, recovery policy and limits.
The real CRM delivery exposed an error-rescue bypass; real-MCP regression tests now assert that no queue entry is created.
<!-- /doc-head -->

# T-0421 One-Lane MVP

## Decision and Scope

The operator's 2026-09-08 ownership directive supersedes the general-graph delivery plan.
Keep d2af4d5 and 8a83bbb as candidate history; do not activate their graph runtime.
The useful minimum is a one-shot local CLI for an explicitly selected project and pane,
using the existing MCP A2A gates, verified sender, result ledger and Hermes participant ingress.
No new watcher, daemon, automatic routing, model launcher or background retry is installed.
This first lane accepts only `scope: "read_only"`. It grants no payment, outreach,
deployment, customer-action, merge or credential authority.

## Use

Run from the checkout of `main`. `WEZBRIDGE_INTEL_DIR` must point to the existing Fleet `_intel`,
not the worktree parent. The order JSON has `id`, `corr`, absolute `project` cwd,
integer `pane`, integer `from_pane`, `scope: "read_only"`, and `body` (maximum 600 characters).
The sender and target pane identities must be verified against the live canonical mux first.
The peer must return `order: <id>` plus an A2A v2 criteria result under the same correlation.

```powershell
node scripts/one-lane.cjs dispatch ORDER.json RECEIPT_ROOT
node scripts/one-lane.cjs collect RECEIPT_DIR EXISTING_A2A_RESULTS.jsonl
node scripts/one-lane.cjs relay RECEIPT_DIR
```

`dispatch` exclusively claims the id and fsyncs the receipt before starting transport.
The optional `a2a_send.expected_cwd` parameter requires the raw pane path and checks
the mux socket, census cwd and last visible TUI cwd before paste, Enter and Enter retries.
The existing foreign-composer guard remains in force. There is no queue fallback.
The return value distinguishes `submitted` from `dispatch_uncertain` even if older MCP
response metadata says `ok: true` for unverifiable delivery.

An existing id is never resent, including after a crash. Inspect its receipt, pane and
result before explicitly creating a new attempt. A crash may leave only the receipt
or a dispatch-started marker: neither means the instruction was not sent.
`collect` matches correlation, both panes, order id, timestamp and criteria structure.
It records `result_received_not_accepted`, never task completion. `relay` uses the existing
scoped-secret injection script and records HTTP response separately; it does not read or log secrets.

## Main Adoption

The 2026-09-09 follow-up explicitly authorizes adoption into `main` and `origin/main`,
a complete suite there, and another real read-only order from that checkout.
Only commit 0101d9d is transplanted onto main baseline 9ce72d1. Its six graph ancestors
are not merged; the executable one-lane files retain the reviewed candidate bytes.
The document map is resolved against main, without references to absent graph documents.

The clean main checkout is `G:/tmp/wezbridge-T0377-adoption-20260908` (branch `main`),
not `G:/tmp/wezbridge-graph-control-20260908` (candidate branch). The shared project
directory is on `orch/tracks-ledger-20260830` with unrelated operator changes and is
deliberately left untouched. Git branch and remote SHA, not a directory nickname,
establish which revision runs. Final evidence and counts are in
`_intel/results/T-0421-main-adoption-result.md` and `G:/tmp/T0421-main-20260909/`.

Activation of this one-shot tool means executing `node scripts/one-lane.cjs` from main;
it does not require replacing the resident daemon or activating any graph runtime.

## First Real Proof (Candidate)

Artifacts: `G:/tmp/T0421-one-lane-20260908/`.
Order: `one-lane-20260908-01`, correlation `jarvis-graph-control-plane-20260908`.

- Receipt persisted before dispatch: `receipts/one-lane-20260908-01/receipt.json`.
- 23:44:24Z: dispatch recorded `submitted: submitted`, `delivered: ok`, target CRM/pane 12, sender pane 94.
- 23:44:51.935Z: actual CRM result in shared `a2a-results.jsonl`; two local read commands,
  cwd `/g/_OneDrive/OneDrive/Desktop/Py Apps/crm`, README absent, no files changed.
- Independently checked README absence with local `Test-Path`; ACK returned through verified A2A.
- `result.json` stores the peer body and SHA-256 `5b43a27069a573c358259f6f381600e349d6ce17c5e013a2fde6fbf0ad5b80ac`.
- 23:45:22Z: read-only query of the real Hermes session database found inbound message 112142
  containing the exact order id and receipt/result hashes. This is stronger than the HTTP 200,
  but is not by itself a Jarvis reply or origin acceptance.
- 23:49:34Z: Jarvis assistant message 112153 explicitly acknowledges `one-lane-20260908-01`
  and accepts the read-only MVP. The exact inbound and assistant rows are preserved in
  `jarvis-conversation-proof.json`; HTTP acceptance was not used as a substitute.

## Candidate Validation and Runtime

Eight focused tests cover receipt-before-send, duplicate/crash handling, excluded scope values,
unknown transport status, wrong socket/project, target change between paste and Enter,
foreign composer and result provenance. `inverse-pin.log` removes the last-write guard
in memory only: the target-change regression then sends Enter to the changed target (exit 1).
The normal test prevents that Enter. Candidate source was not mutated for this inverse check.

Initial full suite: 1,445 passed, 27 skipped, zero failed (`full.log`).
Repeat: 1,444 passed, 27 skipped, one failure (`full-final.log`): the unmodified graph
test `two processes recover abandoned claims without overlapping custody` hit Windows
`EPERM` removing `.graph-control.lock`. Its focused recheck passed (`graph-lock-recheck.log`).
This is retained as an intermittent graph reliability limit, not hidden as a green run;
no graph code was changed or activated to repair it. Final full rerun: 1,445 passed,
27 skipped, zero failed in 96.28 seconds (`full-sealed.log`).
GitNexus could not resolve the actual CJS symbols (one query returned an unrelated repo symbol).
Direct references show the only existing behavior change is opt-in `a2a_send.expected_cwd`;
other MCP callers retain the existing sender. Full-suite coverage checks those consumers.

In the initial proof, only the CLI's short-lived MCP child loaded the candidate. The resident daemon and existing
MCP sessions were not restarted or replaced. The CLI is usable from this worktree; this is
not a global installation. No graph activation, push, merge or secret configuration occurred.

## Limits

### Pinned Rescue Incident, 2026-09-09

The live `deploy-guard-check-20260909` request used an intentionally wrong cwd.
The guard threw, but the generic MCP catch block rescued the request into
`queues/crm.jsonl` without the pin. CRM later received and answered it.
The original verification checked only `isError` and therefore missed the actual
queue side effect; that guard-success claim is invalidated, not recycled as proof.

Any exception on a request carrying `expected_cwd` now returns `queued:false` and
`retry:manual-only` before generic rescue. This also covers uncertain failures after
paste, where replay could duplicate delivery. Ordinary unpinned rescue is unchanged.
`test/pinned-rescue.test.cjs` uses the real stdio MCP server with isolated transport
fixtures and asserts filesystem effects: two failing regressions before the fix,
then no queue file after pin rejection or partial-transport failure. Its legacy
control still creates the expected durable queue record. Evidence: `G:/tmp/pinned-rescue-20260909/`.

- This is a real read-only transport journey, not proof of arbitrary project execution or production readiness.
- The current strict visible-cwd parser supports the observed Claude status bar; unsupported or unreadable layouts refuse.
- Mux validation and the OS write are not atomic. A tiny last-check/write interval remains; no exactly-once claim.
- The local order/ledger are trusted operator artifacts. Hashes detect accidental changes, not a malicious local writer.
- Read-only scope is delegated instruction plus existing A2A policy, not an OS sandbox or semantic classifier.
- No autonomous recovery of uncertain sends or automatic result acceptance. Jarvis retains origin acceptance.
- The existing result linker moved T-0421 to review on this shared correlation. That transition proves no graph criterion;
  the Fleet card must describe the narrowed MVP and must not be marked done by the implementation author.

<!-- doc-head: T-0418 architecture selected and implemented privately; live gates open -->
Reuses existing Hermes and native Codex/SQLite FinalOrchestra with one job owner and a thin finite adapter.
Independent local review passed; host isolation, provider-backed outcomes and live integration remain open.
Read with CONTROL.md and EVIDENCE.md; selection is not a deployment or readiness claim.
<!-- /doc-head -->

# Selected private pilot

## Decision and implementation status

Use the existing adult Hermes gateway as the conversational entry point and its existing governed MemoryMaster provider for user-facing scoped recall. Expose a small submit/status/evidence/pause/resume/cancel tool adapter backed by the existing **native FinalOrchestra Codex/SQLite kernel**. One FinalOrchestra task owns each pilot job; Hermes retains its task ID and does not run a second copy of the work. Use the existing `hermes send` path for bounded outcome notification, not the pane-bridge path that wakes an additional model turn.

The code now implements nine finite tools (including jobs, decisions and health), frozen fixture context, a bounded driver, exact-revision review, local harmless decisions, outbox and stopped restore. Existing governed memory remains the intended source; task-specific live retrieval is not wired or verified in the pilot. The service/plugin are prepared, not activated. See EVIDENCE.md for the difference between implemented contracts and completed acceptance.

Implementation lives in `G:/tmp/finalorchestra-autonomy-20260907`, branch `feat/autonomy-pilot-20260907`, based on original `finalorchestra/main` (exact base recorded in assessment). The installed `_runtime/finalorchestra-mcp` Eve/Postgres checkout and all live registrations stay intact. Wezbridge holds mission documentation and Fleet card T-0418; it is the inspection/fallback interface, not a second job-state store.

## Why this candidate

- Hermes already owns the verified Telegram bot/owner route and MemoryMaster integration. Its native background delegation uses process-local workers; a successful handle is not durable engineering acceptance.
- The existing native FinalOrchestra kernel already executes isolated Codex workers and controller-owned verification, with independent review, fix and retest. It lacks general intake/driver/control/delivery and has measured lease/fencing defects. Extend and repair those surfaces rather than write another unrelated engine.
- The installed Eve control plane has substantial governance, but current controller/Eve listeners are absent; retained recovery trials do not prove completion and encountered hosted quota failure. Requiring those hosted layers adds a demonstrated dependency without a requirement in this pilot. Preserve them as alternatives, do not revive suspended jobs.
- Native Codex Goal is used for this mission and native CLI JSON events for worker execution. Native desktop scheduling/Remote are useful optional interfaces, but local-file scheduling depends on the desktop staying on and Remote availability depends on rollout/settings. They do not establish the requested Telegram-owned durable job flow by themselves.
- Hermes native Codex App Server is present in its source, but the installed VM Codex version is below its documented prerequisite and that runtime is not enabled. Do not switch the live gateway merely to test a challenger. Official Codex guidance prefers SDK for automated jobs and App Server for richer history/approval clients; the existing pinned worker uses supported CLI structured execution.
- Claude Cowork/Dispatch remains a native alternative for non-code jobs. Its documented cloud/local modes and phone interface require separate setup, and no existing Telegram + scoped-memory + independent engineering acceptance integration has been verified here. No production switch justified by this inspection.

## Minimal implementation contract

1. **Task intake, not a second backlog.** Add idempotent operator-origin intake metadata to existing tasks, retaining objective, explicit project/workspace, immutable acceptance specification, allowed actions, selected native specialist/context references, attempt/time limits, next obligation and notification status. Job status is derived from the controller task/review/defect state and control flags, not duplicated in a second independently updated lifecycle.
2. **Allowlisted execution.** Pilot task kinds target owned disposable Git fixtures. The adapter accepts objectives and registered task types, never arbitrary shell commands, working directories, bot/chat IDs or production mutation permissions. Freeze acceptance commands/oracles outside worker-write roots. Compare changed paths and original oracle hashes. A green exit with zero tests, skipped tests or altered acceptance is a failure.
3. **One owner, bounded driver.** One supervised runner drains only pilot intake with a finite job count, two execution attempts/job and recorded per-worker timeout/aggregate limits. Use transactional leases and fencing generations; a second controller cannot claim active work. Do not introduce a clock that repeatedly asks an LLM whether there is work. The API/CLI status path must stay responsive while a worker or verifier runs.
4. **Revocation is enforced.** Pause/cancel revokes the generation/token and terminates or safely fences only owned worker process trees. Check task state, lease expiry, generation, assignment, actor and artifact revision before dispatch, before/after verification and before accepting a result. Persist late events only as stale diagnostic evidence; they cannot complete work. A restart reconciles persisted attempts and existing effects before retry, with ambiguous external effects blocked. Pilot workers have no external-effect authority.
5. **Independent acceptance.** Reuse implementation -> review -> fix -> retest. Reviewers receive the objective/acceptance and current candidate, not hidden seeded-defect instructions. A second model's approval is insufficient: controller-run protected tests, current revision and actual rendered design evidence are required. Deterministic test fixtures exercise a forced rejection; a bounded real run must demonstrate actual reviewer rejection and repair when present, with honest distinction if no real rejection occurs.
6. **Decisions.** The pilot cannot deploy or publish. A harmless gated action tests approval/denial with verified actor, task/action ID, artifact digest, exact scope, expiry, one-use consumption and recorded outcome. Wrong actors, forwarded textual authority, stale artifacts, denial and replay must fail closed. Never fabricate a live owner callback. Production decisions are prepared artifacts only.
7. **Quiet, durable results.** Transactional outbox with task/action identity, bounded retry/backoff and local diagnostics. Normal output is acknowledgement, meaningful result or real decision, without tool logs. Existing `hermes send` handles outbound Telegram without another consumer. Live delivery may be exercised only against the already verified owner chat with harmless labeled text; Telegram acceptance is not owner receipt/read/approval.
8. **Context isolation.** Reuse current domain/project instructions and approved scoped MemoryMaster recall. Permit only explicitly selected, bounded context; store source IDs/digests and redacted uncertainty. Reject returned scopes outside the task allowlist. No transcript corpus import, new memory authority or automatic skill promotion.
9. **Operations.** Use local SQLite on one host, protected against worker access; backup through supported consistent backup into a disposable restore. Provide finite `run`, status, health, emergency stop and rollback commands. Install/activate a bounded private pilot only after tests; live Hermes tool registration or service cutover remains a concrete reviewable final gate when required by existing ownership.

## Initial evaluation set

- Synthetic reference CRM search change, controller-protected tests, independent reviewer, rejection/repair, forbidden deployment attempt.
- Infra read-only evidence digest from narrowly supplied sanitized fixtures, no network/system writes.
- One local marketing draft grounded in task-provided product/brand facts; no invented metrics, price, contact or publication.
- Rendered synthetic UI reviewed independently for narrow desktop/mobile layout and keyboard/accessibility criteria; build status alone is insufficient.

All are linked to T-0418, use separate scoped workspaces and produce one durable result each. Recovery/decision/outbox adversarial fixtures test concurrency, duplicate/out-of-order messages, overlapping occurrence identity, worker/controller death, timeout/quota, stale completion, notification failure and backup restore. Longer soak and live callback gates remain explicit.

## Primary source anchors checked 2026-09-07

- https://learn.chatgpt.com/docs/long-running-work
- https://learn.chatgpt.com/docs/app-server
- https://learn.chatgpt.com/docs/automations?surface=app
- https://learn.chatgpt.com/docs/remote
- https://github.com/vercel/eve
- https://support.claude.com/en/articles/13854387-schedule-recurring-tasks-in-claude-cowork
- https://support.claude.com/en/articles/13947068-assign-tasks-from-anywhere-in-claude-cowork

Detailed native Hermes and local runtime evidence are in the bounded inventory reports. No numerical architecture scores or unmeasured benefit estimates are assigned.

## Current alternatives and operating burden

| Option | Fit and explicit reason for this decision |
|---|---|
| Native Codex Goal + CLI/SDK | Goal carries the current mission; structured bounded CLI work reuses the installed kernel adapter. SDK is the smaller native embedding option; App Server is appropriate if rich history/interactive approval events become necessary. Neither by itself is the existing Telegram job owner. Keep normal supported CLI login; do not transfer tokens into another framework. |
| Codex custom agents, automation, Remote | Native project agents can preserve named capabilities, but the four private fixtures use finite direct worker prompts. Desktop local automation depends on its host; hosted scheduling cannot be assumed to see local project folders. Remote is an optional rollout/settings-dependent interface, not verified here or a Telegram replacement. |
| Hermes native profiles/Bot Mode/delegation | Best existing conversation/identity/memory fit. Current Bot Mode documentation describes profile-scoped tools/MCPs, routines and attributed asynchronous messaging. Those product features do not establish exact-artifact engineering acceptance or crash-safe job ownership on the installed gateway. Do not add another scheduler or bot consumer. |
| Native FinalOrchestra0.1.0 | Selected authoritative task/SQLite/evidence owner. Existing leases/worktrees/reviews reduce new machinery; this mission repaired stale-authority gaps and added intake/control/delivery. Operating burden:one bounded private controller plus existing Hermes. Model isolation still blocks activation. |
| Installed FinalOrchestra0.4.0 + Eve/Postgres | More comprehensive hosted governance, but controller/Eve listeners absent and retained completion blocked by quota. More services, hosted storage/OIDC/sandbox dependencies and migration risk. Preserve without reviving historical work. Eve remains a challenger; this task does not prove arbitrary subscription auth compatibility or self-hosted full-stack independence. |
| Wezbridge | Retain interactive inspection, peer delivery and existing wake recovery. It should not own a second copy of the same execution state or translate every machine step into keystrokes. No new watcher. |
| Claude Cowork cloud / Dispatch | A separate native alternative. Current cloud Cowork can continue and schedule without an online device; local files/connectors/browser require the connected desktop. Dispatch is limited-beta Pro/Max desktop+mobile, with desktop awake/app open; Linux computer use is unavailable. Existing account eligibility, installation and Telegram/governed-memory integration were not verified. No switch justified yet. |

Hermes Bot Mode source: [profiles, routines and attributed messaging](https://hermes-agent.nousresearch.com/docs/user-guide/bot-mode). Codex: [native agent files](https://learn.chatgpt.com/docs/agent-configuration/subagents), [SDK/App Server choice](https://learn.chatgpt.com/docs/app-server), [local/hosted automation](https://learn.chatgpt.com/docs/automations?surface=app), [Remote](https://learn.chatgpt.com/docs/remote). Cowork: [cloud/local access](https://support.claude.com/en/articles/15520349-use-claude-cowork-on-web-desktop-and-mobile), [Dispatch requirements](https://support.claude.com/en/articles/13947068-assign-tasks-from-anywhere-in-claude-cowork). Checked2026-09-07; source features are not installed-runtime proofs.

Costs are unknown beyond observed failure/limits. No price assumptions justify migration:the current Eve artifact recorded quota402 and this mission's specialist calls later hit a usage limit. No purchases, quota cycling or recurring paid runs were authorized. Current development bounds are one worker slot, two author attempts/job, four phase dispatches/job, twelve aggregate dispatches, two minutes/worker and thirty seconds/verification. They are persisted and do not reset by restarting the CLI.

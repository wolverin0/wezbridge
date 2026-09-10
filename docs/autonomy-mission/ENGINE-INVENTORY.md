<!-- doc-head: Read-only FinalOrchestra engine inventory for CODEX_AUTONOMY_MISSION -->
Verified 2026-09-07 around 22:11Z: two different checkouts, native SQLite kernel and installed Postgres/Eve controller.
Records source, runtime observations, a hashed cancelled recovery fixture, reuse candidates and remaining gates.
No workers, jobs, external messages, services, test suites or provider operations were started by this inventory.
<!-- /doc-head -->

Recommendation: use native Codex execution under the mission's single durable owner, reusing FinalOrchestra's small kernel and proven custody/evidence contracts. Do not make Eve/hosted sandboxes a dependency of the first autonomous lane. This is a source-based architectural recommendation, not a claim that a replacement already works. Hermes suitability is outside this report.

## Two implementations and current runtime

| Surface | Verified state |
|---|---|
| Original checkout | `G:\_OneDrive\OneDrive\Desktop\Py Apps\finalorchestra`; branch `main`; HEAD `ad2794671b00a1e499c9ecad3ef025d56078cb03`; package `0.1.0`. TypeScript + better-sqlite3, pinned Codex SDK `0.150.0`. |
| Original dirty state | Modified `STATUS.md`; untracked `.playwright-mcp/`, `ROADMAP.md`, `bash.exe.stackdump`, and three `finalorchestra-*.png` screenshots. Preserved. |
| Installed runtime checkout | `G:\_OneDrive\OneDrive\Desktop\Py Apps\_runtime\finalorchestra-mcp`; branch `fix/local-supervisor-port-watch-20260904`; HEAD `40a7db5f92028f5e356b61f5525afc9352a8db81`; clean in both initial and final checks; package `0.4.0`. |
| Installed packages | Runtime package files report `@openai/codex-sdk 0.151.0`, `better-sqlite3 12.11.1`, and `eve 0.41.0`. Control-plane uses Next/Drizzle/Postgres; imported software factory requires Node 24.x. Inspection shell Node is 22.14.0. |
| Processes | Eight Windows `node.exe` stdio MCP clients point to runtime `dist/src/mcp/cli.js`. They are not eight executing workers. No matching TCP listeners for these stdio processes. |
| Current listeners | Ports 3100 and 4010/4011/4012 absent. Port 55432 present. `docker inspect finalorchestra-postgres` reports `Running=true`, restart policy `unless-stopped`. No controller/Eve service was started or repaired. |
| Loaded version limit | MCP process script path is verified; exact loaded source SHA is not. Dist MCP/executor timestamps are 2026-09-06 18:13Z; package version/HEAD cannot certify every long-lived process's loaded revision. |

The remote-chat TS/SQLite hypothesis describes the original native kernel accurately. The global FinalOrchestra/Eve context describes the later installed Postgres/Eve implementation. Treating either as the sole current codebase would be wrong. The original STATUS suspension headline is stale relative to the runtime's explicit scratch-testing exception, while historical P0 jobs remain suspended. Current runtime availability is narrower than either historical readiness narrative.

Read order followed: global `finalorchestra-eve.md`, each checkout's `AGENTS.md`, then `docs/DOCS-MAP.md`. GitNexus returned `Repository finalorchestra not found`; no wrong-repository symbol results were used and no index was created.

## Reuse map

Paths below are relative to the indicated checkout.

| Capability | Concrete implementation | Reuse assessment |
|---|---|---|
| Local durable state | Original `src/db/schema.ts`, `src/db/database.ts`: WAL SQLite schema v3 with projects, requirements, dependencies, tasks, leases, worktrees, dispatches/events, evidence, reviews, defects. Transactions around transitions. | Small starting point for local jobs. Schema lacks modern correlated origin decisions and delivery outbox. Do not instantiate `FactoryDatabase` for read-only inspection; its constructor migrates. |
| Native execution | Original `src/workers/codex-exec-worker.ts`; `exec --json --ephemeral`, explicit cwd/sandbox, bounded stdout/stderr, process-tree timeout; `src/runtime/worker-dispatcher.ts` binds logical identities/worktrees and persists events during execution. Runtime adds `AbortSignal` cancellation. | Reuse newer cancellation-aware adapter plus protocol tests. Original adapter has no durable resume/fork and no external cancellation signal. |
| Independent review and repair | Original `src/runtime/factory-engine.ts`: implementation -> review -> failed defect -> leased fixer -> fresh independent retest. `src/core/controller.ts` rejects shared known thread/self-review, stale lease and untrusted evidence. | Reuse deterministic checks; scripted loop proof does not establish real unattended coding/review success. |
| Durable hosted job model | Runtime `apps/control-plane/src/db/index.ts` uses `postgres()`/Drizzle and mandatory DATABASE_URL. Schema `src/db/schema.ts` under that app stores jobs, hashed/versioned leases, approvals, origins, briefs, coverage, reviews, results, origin judgments, outbox and audit. | Contracts/invariants valuable. Entire Next/Postgres/Eve stack is a substantially larger adoption than native local jobs. |
| Correlation/idempotence | Runtime `apps/control-plane/src/app/api/jobs/route.ts`: transactional job/intake/origin inserts, unique idempotency key and unique `(originProject, correlationId)`; duplicates return or reject without a second job. | Preserve one authoritative task with linked attempts and one origin correlation. |
| Claim/repository custody | Runtime API `worker/jobs/[jobId]/claim/route.ts`; `lib/repository-dispatch-lock.ts`: transactional claim, hashed token, approval/capability checks; Postgres advisory transaction lock guards same-repository CHANGE overlap. | Preserve claim compare-and-set and repository exclusion semantics in chosen store. |
| Lease recovery | Runtime `lib/lease-recovery.ts`, API `worker/jobs/next/route.ts`: RESUME only when local Foreman session exists; otherwise pre-start REQUEUE, post-start BLOCK. Executor reattaches using persisted session/event offset. | Safe-side-effect boundary is reusable. Native kernel `recoverInterruptedDispatches()` only marks running dispatches interrupted; it does not reconnect native Codex execution. |
| Cancellation | Runtime API `jobs/[jobId]/cancel/route.ts`: immediate queued/approval/input cancellation; active cancellation request; replay idempotent; terminal BLOCKED refused. Remote executor renews lease, aborts on request, records cancellation evidence/receipt. | Reuse semantics and adapter tests. Cancellation preserves partial work; it is not rollback/deletion. |
| Operator decisions | Runtime `lib/origin-operator-decision.ts`: reads canonical origin rulings, binds task/job/correlation/base SHA, rejects missing/mismatched authority. `standing-authorization-policy.ts` scopes existing authority. | Reuse exact origin authority; avoid a second task backlog or duplicate approval surface. |
| Acceptance | Runtime `lib/origin-judgment-policy.ts`: checked evidence/digest, final revision, coverage, defects, independent reviewer. `release-candidate-policy.ts` yields only CANDIDATE_PASS. | Good deterministic core. Author verdict must never substitute for independent review/origin acceptance. |
| Result outbox | Runtime receipt API atomically inserts result, criteria/evidence/review, unique `jobId:RESULT:v1` outbox and removes lease. `lib/delivery-outbox-policy.ts`: 8 bounded attempts, exponential retry; delivery API leases/reclaims/dead-letters. `src/remote/result-delivery.ts` separates provider receipt from acceptance and bounds A2A envelope size. | Reuse durable receipt/inbox/outbox pattern. Do not drain old outbox or take over historical jobs. |
| Eve repair loop | `apps/software-factory/agent/instructions.ts` specifies classifier/analyst/implementer/reviewer and at most 2 revision cycles; stations are in `agent/subagents/`. | This instruction is not by itself deterministic cap proof. Avoid coupling initial lane to Eve sandbox/Quota/OIDC complexity. |

## Recent bounded job evidence, freshly inspected

Job `JOB-9b24bf46-b856-496c-af09-3ca046735d1c` is the authorized R5 synthetic overlap/recovery fixture. It is not a historical P0 task. Files under runtime `artifacts/rethink-e2e/r5-matrix/` were read only:

- `manifest.json`: duplicate submission has the same job ID.
- `overlap-snapshot.json`: execution started `2026-09-06T18:10:44.790Z`; audit records exact fixture lease fault, `EXPIRED_FOREMAN_SESSION_REATTACHED`, cancellation request, terminal cancellation. Root `wrun_01M1VYMR6YFTTM8BEYX162F2C5` remains stable.
- `quota-cancellation.json`: provider returned `402 payment_required`, Snapshots Storage quota; cancellation requested `18:18:54.652Z`.
- `overlap-result.json`: CANCELLED at `18:19:08.313Z`, no final commit/branch, four criteria BLOCKED. Stored evidence `EVD-6596446e-ce43-4e55-a963-adab3c3c845b`.
- `overlap-uniqueness.json`: one job/root/result/terminal audit, repeated result unchanged. Snapshot shows zero leases.
- `terminal-proof.json`: stored native `turn.cancelled` then `session.waiting`, one result, zero leases.

Fresh read-only assertion cross-checked job IDs, cancellation states, uniqueness and zero leases: PASS. Recomputed SHA256 of JSON.stringify(evidence.payload): `2dcfd61666c3ab780e09356b1f770fa3ce99ef445b80a4f62623c50ead8fcd1a`, exactly matching the evidence record. Whole `overlap-result.json` file digest: `87dd3e3a6401e349fcd1918c4db1521f6530ee0e25d25851392e2cbc8a33f2f2`.

This verifies integrity and consistency of retained evidence, not current database state, current provider quota, successful product output, or a newly repeated live recovery. No private transcript was copied to this report. Successful recovery -> exactly one reviewed draft PR remains unproved. Earlier fixture A ended BLOCKED on OIDC; B was cancelled after quota failure.

## Existing checks and readiness limits

Original commands: `npm test`, `npm run check`; `npm run test:codex` is opt-in through FACTORY_RUN_CODEX_INTEGRATION=1 and invokes a real model. Relevant tests: `tests/controller.test.ts` (restart, stale lease, self-review, trusted evidence, defects); `tests/worker-dispatcher.test.ts` (events persisted during run); `tests/factory-engine.test.ts` (scripted failure/fix/retest); `tests/worktree-manager.test.ts`; `tests/codex-exec-worker.test.ts` (malformed/terminal protocol and process-tree timeout).

Runtime commands: `npm test`, `npm run check`, `npm --prefix apps/control-plane test`; `npm run verify` combines those. Build is `npm run build`. Control-plane check runs Next type generation/TypeScript/Biome and factory check expects Node 24. Database migration/concurrency scripts mutate test databases and were not invoked.

Particularly relevant runtime tests: `tests/r5-cancellation.test.ts`, `tests/r5-recovery.test.ts`, `tests/worker-daemon.test.ts`, `tests/result-delivery.test.ts`, `tests/rethink-blind-review.test.ts`; control-plane `tests/lease-recovery.test.ts`, `scoped-job-recovery.test.ts`, `execution-start-recovery.test.ts`, `origin-operator-decision.test.ts`, `origin-judgment-policy.test.ts`, `delivery-outbox-policy.test.ts`, `release-candidate-policy.test.ts`.

Historical 2026-09-06 report records root 209 PASS/1 opt-in SKIP, control-plane 141 PASS, check/build exit 0; branch coverage 77.26%. Suites were inspected, not rerun in this read-only inventory. This is not fresh green test evidence. Do not invoke `rethink-r5-matrix.ts` as a harmless verifier: the script also implements mutation/dispatch/recovery modes and writes artifacts. Its recorded verify modes deliberately fail the required COMPLETED assertion for both attempts.

Remaining material gaps:

1. Native durable adapter needs real crash/restart, duplicate wake, cancel, lease loss and exact one-result evidence under the chosen owner. Original ephemeral execution cannot supply resume semantics by itself.
2. R7 blind-review input isolation still fails. `src/workers/rethink-blind-review.ts` detects specific seeded instruction leakage/missing inputs; it is a targeted oracle, not prevention or a general leak detector.
3. Separate provider review and fully unattended end-to-end successful recovery are not established.
4. Latest provider-capacity failure is historical evidence. No live provider query, paid plan, cleanup or sandbox activation was performed; do not assume quota is now available.
5. No current controller/worker availability, loaded-build identity or protected hosted candidate acceptance was proved.
6. Full reboot/orphan-worktree reclamation, authorization persistence, linked retry bounds and transactional outbox ownership need an explicit integrated proof before declaring autonomy ready.

## Concrete v0.1 pilot extension points for T-0418

The following are proposed changes for an isolated branch of the native kernel, not changes made by this inventory. Keep installed `_runtime/finalorchestra-mcp` unchanged. Mission/control reference supplied by the owner: `G:/tmp/wezbridge-autonomy-20260907/docs/autonomy-mission/CONTROL.md`.

| Need | Existing seam and missing behavior |
|---|---|
| Arbitrary intake | `src/cli.ts` currently exposes only init, project create, status and release-check. `CreateTaskInput`/`FactoryController.createTask` hold an objective, role and requirement IDs, not a typed arbitrary job, origin ID, correlation, action authorization or idempotence contract. Add a strict intake schema and a small service facade around existing controller methods. Distinguish Git coding from non-code investigation/reporting; do not force arbitrary tasks to create commits or bypass isolation. Define explicit allowed actions, inputs, output contract, repository/root, origin/task ID and acceptance requirements. |
| Owner and attempts | SQLite task attempt exists, but there is no explicit origin attempt chain, runtime identity/heartbeat ownership or general daemon facade in this bootstrap. Add one durable owner and explicit attempt records, with linked retries inside the same origin task. Thin Hermes tools should submit/read/cancel/provide exact decisions through that facade; Hermes must not maintain a competing queue or directly rewrite SQLite. |
| Cancellation | `TaskStatusSchema` has no CANCELLED or CANCEL_REQUESTED; original WorkerRequest has no signal. Add persisted request/ack and refusal rules, then port the runtime cancellation-aware native worker and R5 tests. Kill only the owned process tree; preserve partial evidence/worktrees. Define pre-start cancellation as no execution and active cancellation as a request requiring acknowledged terminal evidence. |
| Fencing: source finding | `WorkerDispatcher.requireAssignment()` and `FactoryController.submitTask()` check token/status but do not compare current time against `lease_expires_at`; expiry enforcement depends on a separate `expireLeases()` call. `persistResult()` checks dispatch status RUNNING, not current task lease/attempt; `persistEvent()` accepts by dispatch ID without state fencing. Thus the existing stale-lease tests do not establish every late-completion boundary. Add transactional lease/attempt/cancel fences at dispatch, authoritative evidence, completion and decision consumption. Preserve late observations as non-authoritative audit if useful. Do not claim an old child stopped merely because its lease row changed. |
| One-use exact-artifact decision | Native schema has no approval/decision rows. Modern origin decisions bind task/job/correlation/base SHA; that still does not implement a general single-use artifact/action capability. Add immutable decision request/decision/consumption records binding exact artifact digest, operation, target, repository/base revision, task/attempt, actor, expiry and origin ruling. Consume atomically with the authorized transition using a uniqueness/CAS guard; replay may return the same recorded effect but cannot authorize another artifact/action. A changed artifact or scope must invalidate that request. This is a proposed implementation gate, not existing behavior. |
| Durable notifications | Native messages are persisted inbox-like rows with acknowledged_at, but no external delivery lease, retry schedule, idempotency key, provider receipt or dead-letter state exists. Add transactional result+notification outbox insertion. Port runtime delivery policy/settlement semantics, with separate delivery/ack/acceptance states; restart must reclaim only the pilot's expired delivery leases. Keep a readable durable inbox even when transport fails. |
| Acceptance and review | Keep `VerificationRunner`, artifact digests, final revision binding and independent reviewer rules. Make arbitrary non-code artifacts use deterministic acceptance appropriate to their type. One-use operator approval permits only its recorded action; it never certifies authored work as correct. |

Minimum new proof set before any pilot readiness claim: duplicate intake -> same job; elapsed lease rejected without first calling the sweep; lease replacement/cancel -> late child cannot finalize; cancel before start -> no process; two consumers -> one exact decision use; artifact or target change -> decision rejected; result plus outbox atomic across restart; delivery failure -> durable retry/inbox; duplicate delivery acknowledgement -> no duplicate effect; independent review/repair -> new evidence at final revision. Use fake workers and owned scratch resources first, then one bounded real native job. Preserve existing original checkout dirtiness by using an isolated branch/worktree.

The useful next slice is one synthetic native job in an isolated execution root, with origin authority, exclusive lease, explicit executor identity, independently tested evidence, cancellation, linked retry and one durable result. Implement that under the existing mission/ledger owner; FinalOrchestra is a source of reusable code and invariants, not permission to revive its old queues.

<!-- doc-head: Independent bounded architecture review for T-0418, 2026-09-07 -->
Adversarial read-only review of ARCHITECTURE.md and CONTROL.md against three inventories and the native kernel source.
Findings address authority transport, actual execution isolation, responsive controls, recovery, task acceptance and measured benefit.
Recommendation: proceed with the existing native kernel after the high-priority contracts below are concrete and adversarially checked.
This is private-pilot design review, not production authorization or runtime acceptance; no code, providers, services or messages changed.
<!-- /doc-head -->

# Review verdict

**CONDITIONAL PROCEED for the bounded local pilot.** Reusing the native Codex/SQLite kernel, adult Hermes route and MemoryMaster is defensible. A second queue, watcher, general workflow framework, hosted Eve dependency or new Telegram consumer is unnecessary. The architecture recognizes most known custody failures. It still leaves two safety-critical implementation boundaries implicit and one control-path contradiction in the reused source. Resolve HIGH findings before launching a real worker or executing its code. MEDIUM findings should be reflected in acceptance before claiming the pilot complete.

References `ARCHITECTURE.md` and `CONTROL.md` mean the copies under `G:/tmp/wezbridge-autonomy-20260907/docs/autonomy-mission`. Kernel source means `G:/tmp/finalorchestra-autonomy-20260907`. Source was read, not executed. Inventory evidence is dated, and the review does not upgrade historical results into current proof.

## Findings

### R1 — HIGH: the cross-host authentication and actor provenance boundary is not specified

**Evidence:** ARCHITECTURE:11,26,31 promises a Hermes tool facade and verified actor, but :13 places the owner in a Windows development checkout. The Hermes inventory locates the active gateway on the Ubuntu VM, confirms two allowed Telegram identities, and explicitly says the second identity is not autonomy-job authority. The inventories do not identify an existing callable native-kernel submit/control transport. A local SQLite API is not automatically reachable from that gateway.

**Failure:** implementation can drift into accepting a model-supplied `actor`, arbitrary target/working directory, unsigned HTTP request, or the entire two-user Telegram allowlist as authority. Alternatively, a local-only happy path can be mislabeled as the promised conversational job flow.

**Smallest fix:** record the execution host and choose exactly one transport for this pilot. Start with local CLI/function contract tests; for the VM adapter use an already-authorized fixed transport if available, or leave transport activation as an explicit final integration gate. Derive actor/chat/session from the authenticated Hermes event context, not tool arguments or recalled text. Bind the adapter credential to the pilot task types and fixed execution root. Define idempotency identity from trusted origin plus request key; same key/different objective or scope must conflict. Gate submit, status/evidence, pause/resume/cancel and decisions consistently; status/evidence must not leak another principal's task.

**Required evidence:** reject the second allowed Telegram identity; reject forged actor/forwarded authority; reject anonymous/replayed wrong-scope adapter requests; demonstrate duplicate same-origin intake returns the same job. Local contract tests are sufficient for implementation readiness. Do not require a production gateway cutover to finish those tests.

### R2 — HIGH: file placement and `--sandbox` alone do not establish the promised worker/verifier isolation

**Evidence:** ARCHITECTURE:27,29,34 says workers cannot affect external systems and cannot reach the ledger/protected oracle. Existing `src/workers/codex-exec-worker.ts:23-28` inherits process environment; :77-87 passes only `exec --json --ephemeral --sandbox ... -C ...`. It does not establish a clean native profile or disable inherited external tools/configuration. `src/runtime/verification-runner.ts:22-30` launches the acceptance executable in the candidate worktree with controller process authority and inherited environment. Keeping the oracle outside the write root does not prevent candidate code invoked by the oracle from reading/writing elsewhere.

**Failure:** candidate code or inherited tools can reach controller state, unrelated files, credentials or external integrations. A protected test can still execute an untrusted import/package lifecycle script with controller privileges. Post-run diff checking detects some damage after it occurs; it is not preventive isolation.

**Smallest fix:** define a per-run native execution profile and allowlisted environment, explicit allowed read/write roots, network/tool capability policy, and no inherited global hooks/MCP tools with external-effect authority. Run candidate execution and verification under a proven sandbox boundary, including the candidate code executed by protected tests. Keep ledger, decision secrets and oracle write access outside that boundary. Reuse the runtime's existing supported sandbox; do not invent a new sandbox framework or provision new external credentials. If the selected native mode cannot prove the boundary, restrict that stage to deterministic fake-worker tests and report the real-worker gate honestly.

**Required evidence:** harmless sentinel probes establish denial of writes to controller DB/oracle/another task root and denial of unapproved reads or outbound effects under the actual worker and verifier launch profiles. Verify the active profile's effective tools/environment without printing secret values. Designate precise acceptable auth access needed by Codex itself; the worker task must not inherit general application authority.

### R3 — HIGH: reusing the synchronous verifier can make status/cancel and leases unresponsive

**Evidence:** ARCHITECTURE:28 requires responsive status while worker/verifier runs and :29 requires live revocation. Existing `VerificationRunner.run` uses `spawnSync` (`verification-runner.ts:22`), with default timeout 120 seconds. `FactoryEngine.implement/review/fixDefect/retest` invokes it inline (`factory-engine.ts:44,70,101,125`). Lease expiry, cancellation and outbox management in the same Node event loop would stop during this call.

**Failure:** the exact period in which an acceptance command hangs is also when the user cannot pause/cancel, the lease cannot renew, and another runner may consider it lost. Fencing after the call protects finalization but does not provide the promised operational controls or terminate verifier descendants.

**Smallest fix:** make verifier execution asynchronous with owned-process cancellation, or isolate the finite execution runner in one child process while the existing control/status process remains responsive. Use the same narrow cancellation/fencing contract for verifier and model workers. No new daemon layer is required beyond the single supervised runner already proposed.

**Required evidence:** while a deliberately slow verifier is active, a separate status request returns promptly; pause/cancel records and acknowledges within a defined timeout; the owned verifier process tree stops; a late success cannot finalize; lease renewal or safe expiry semantics remain deterministic.

### R4 — MEDIUM: pause, cancel and restart still need distinct persisted semantics

**Evidence:** ARCHITECTURE:29 groups pause/cancel and allows terminating **or fencing**. The engine inventory says native recovery currently marks dispatches interrupted but does not reconnect Codex execution. Native process-tree timeout support does not persist a PID/start fingerprint or prove death after controller loss. CONTROL:41-43 requires resume and worker/controller interruption tests.

**Failure:** a fenced orphan can continue modifying its assigned workspace while resume starts another process against it; a restarted controller may kill a recycled PID; cancellation can be reported complete before the process actually stops. A pause may consume the entire two-attempt budget without a declared policy.

**Smallest fix:** explicitly distinguish `PAUSED`/resume eligibility, cancellation requested, acknowledged cancellation and terminal result. Persist attempt identity plus process identity/start fingerprint and execution-root ownership. Before retry/reuse, prove the old owned process exited or quarantine its worktree and use a fresh root; ambiguous ownership blocks that attempt without broad process killing. Resume allocates a new fence generation. Define whether interrupted or user-paused work consumes an execution attempt; operator actions must never silently reset the total cap.

**Required evidence:** kill the controller with an owned child active, restart, and demonstrate no concurrent writers or duplicate acceptance; test cancel before spawn, pause/resume, PID mismatch refusal and late stale completion. This is a short adversarial fixture, not a production reboot/soak demand.

### R5 — MEDIUM: the generic Git/test acceptance contract conflicts with non-code specialist tasks

**Evidence:** ARCHITECTURE:27 applies disposable Git fixtures and rejects zero/skipped tests to all task kinds. Initial evaluations :39-40 include a read-only digest and marketing draft. Existing `FactoryEngine.implement` requires a clean changed commit (`factory-engine.ts:39-44`); `domain/types.ts` is coding-role-oriented. The context inventory records native marketing content-creator and design-reviewer contracts, with diagnosis/draft outcomes rather than code test requirements.

**Failure:** every task becomes a fake coding task with meaningless commits/tests, or the implementation adds a broad arbitrary-workflow abstraction to evade this restriction. Either obscures the actual useful outcome and enlarges the pilot.

**Smallest fix:** register only four finite task types. Each has a fixed input root, native specialist/context references, permitted output paths and a small acceptance specification. Engineering requires real protected tests; infra/marketing require substantive content/provenance/scope checks and independent review; design requires rendered evidence and specific UI checks. A Git fixture may store artifacts without claiming that a commit or dummy test proves their quality. Interpret zero/skipped-test rejection as applying only when the task's declared test gate requires tests. Preserve the single task/attempt/result lifecycle; no generic orchestration DSL is needed.

**Required evidence:** one read-only digest and one draft complete through their appropriate acceptance without arbitrary shell intake or irrelevant testing, and the task manifest resolves existing specialist instructions rather than a generic prompt invented by the controller.

### R6 — MEDIUM: exact-result durability must be separated from Telegram delivery ambiguity

**Evidence:** ARCHITECTURE:32 correctly proposes transactional outbox and distinguishes Telegram acceptance from owner read/approval. It does not define crash-after-send-before-outbox-ack handling. Hermes inventory notes `hermes send` can return zero for skipped sends and requires structured success/skipped inspection. The finite native sender does not establish a provider idempotency key for exactly-once Telegram messages.

**Failure:** retry after an ambiguous send can duplicate a Telegram notification, or a zero exit can mark a skipped notification delivered. Neither should alter job acceptance. A test that proves one result row must not be reported as proving exactly one physical message.

**Smallest fix:** retain exactly one authoritative result and unique outbox identity; separately record pending/sent/failed/ambiguous delivery, provider receipt if present, and bounded retries. Parse structured `success`/`skipped`; never accept exit 0 alone. Declare at-least-once notification behavior or stop ambiguous sends for operator-visible inspection; do not promise impossible exactly-once delivery without a provider-supported dedupe contract. Status remains available from the durable result even if notifications fail.

**Required evidence:** skipped send stays undelivered; timeout after potential acceptance preserves ambiguity; duplicate local acknowledgements are idempotent; notification text carries the stable task ID. One harmless live send can prove transport acceptance, without fabricating owner acknowledgement.

### R7 — MEDIUM: completion and benefit criteria need a small explicit measurement record

**Evidence:** CONTROL:44 requires a bounded real rejection/repair/retest pilot, while ARCHITECTURE:30 weakens this to rejection 'when present'. CONTROL:17 names reduced coordination as the outcome, but neither document specifies observable counts. The context inventory confirms 15,444 indexed sessions with zero deep parsing/feedback/receipts; its zeros cannot serve as a historical coordination baseline. CONTROL:45 also requires fresh-session reconstruction and missing/conflicting scoped context, beyond simple successful recall.

**Failure:** a real first-pass success plus scripted forced rejection can be reported as a real observed repair loop, or four completed tasks can be reported as a measured reduction in operator coordination. Merely returning in-scope memory says nothing about stale/conflicting claims or task-relevant context quality.

**Smallest fix:** add one small per-evaluation record: objective/acceptance hash, task/root IDs, context source IDs/digests, attempts, model turns/duration, operator interventions categorized as decision/correction/status/chasing, elapsed time, independent verdict, final revision and notification state. No new analytics ingestion or telemetry service. Keep real observed rejection/repair and deterministic forced-rejection evidence distinct; if no real rejection occurs, record that criterion pending or explicitly change the mission criterion with the operator's actual authority, not silently. Add fixtures for missing context, conflicting current instructions, wrong-scope recall and a fresh session reconstructing the same durable task. Preselect the comparison method; historical reduction remains unmeasured until a comparable baseline exists.

**Required evidence:** the final four-task report can identify exactly which useful outcomes passed, how many interventions happened and which benefits remain unmeasured. An in-scope but irrelevant recall must not be counted as a context-quality pass.

## Smallest sufficient execution order

1. Specify R1 origin/host contract, R2 actual worker/verifier boundary and R3 responsive controls. Build these against one deterministic synthetic engineering fixture.
2. Add the narrow transactional intake/fence/control/result-outbox/decision records to the existing kernel, with no duplicate job lifecycle. Run the listed denial, stale-event, controller-loss and ambiguous-delivery tests before model execution.
3. Run one bounded real engineering job using the isolated profile, existing independent review and protected acceptance. Keep its measured result even if a provider limit or missing real rejection prevents a stronger verdict.
4. Add only the remaining three registered task types with their existing specialist context and appropriate acceptance. Verify fresh-session task reconstruction and scoped recall.
5. Prepare the concrete Hermes adapter and operator commands. If authorized, perform the single harmless owner-targeted notification proof. Leave live gateway registration/cutover and elapsed soak as explicit gates; they need not block the complete local private-pilot evidence package.

## What is already sound

One task owns durable truth; the active Eve installation and historical jobs remain intact; the pane bridge is not misused as a notification path; recalled text cannot grant permission; decisions are artifact/action-bound and single-use; author and reviewer are separate; no fabricated numeric readiness score is proposed. Keep these decisions. The main work is to make the existing boundaries executable, not add more architecture.

Only this review file was written. No provider, network, memory ingestion, job, scheduler, service, external message or repository mutation was performed by this review.

<!-- doc-head: Independent autonomy authority, backup and final operator-interface review, 2026-09-07 -->
Reviews controller authority, driver recovery, protected fixture oracles, backup/restore and notification trust boundaries.
Checkpoints: 67/67 core/fixture tests PASS; latest added backup/notification scope 40/40 PASS plus actual stopped CLI restore rehearsal.
Final read-only operator/service/oracle review found no new material issue; offline systemd syntax passed with Windows-mount permission warnings.
Reviewer owns three regression files; root owns implementation and fixture changes.
<!-- /doc-head -->

# Bounded result

The reproduced authority/fencing defects are corrected in the reviewed source snapshot, and **9 focused regressions pass**. This supports proceeding with local integration. It does not establish complete job recovery, real provider acceptance, isolated Git metadata or production readiness. The reviewer-authored tests themselves still require the implementation owner's review; passing them is not self-approval of the whole change.

Workspace: `G:/tmp/finalorchestra-autonomy-20260907`. Reviewed: `src/core/controller.ts`, `lease-authority.ts`, `src/runtime/factory-engine.ts`, `verification-runner.ts`, `process-runner.ts`, and later `src/autonomy/job-store.ts`. Implementation was changing concurrently; timestamps below distinguish actual failure evidence from later passing runs.

## Reproduced findings and disposition

| Finding | Severity / consequence | Failure evidence | Author correction inspected | Latest focused status |
|---|---|---|---|---|
| Prior-attempt implementation evidence reused after block/requeue/new lease | HIGH: new attempt enters REVIEW without verification | `refuses prior-attempt evidence after lease revocation and requeue` failed because submit did not throw | Hash-bound artifact now records task/worktree/attempt/lease digest; consumer joins current active assignment and validates tuple | PASS |
| Assigned HEAD changes after verification | HIGH: current submitted work is unverified | `refuses implementation evidence when assigned HEAD changed after verification` failed | Consumer checks current clean Git HEAD equals evidence revision | PASS |
| Dirty edits after verification | HIGH: completion can refer to work not represented by the accepted revision | `refuses dirty candidate changes after authoritative verification` failed | Consumer requires clean worktree at submission, not only during verification | PASS |
| Process error alongside exit 0 accepted as authoritative success | HIGH: host/sandbox errors become false green | `never records passing authority when execution reports a process error` failed with injected EPERM + exit0 | `VerificationRunner.finish` maps any non-null process error to exit -1 | PASS |
| Abandoned reviewer assignment can still close a task | HIGH: revoked reviewer custody bypasses fresh acceptance | `refuses independent-review evidence after its assignment was abandoned` failed | `reviewTask` and `retestDefect` use current active purpose/actor assignment, task/attempt, HEAD and clean-worktree checks | PASS |
| Successive job phases reuse one finish generation | HIGH: duplicate old finish can alter a new phase | `assigns a fresh finish token to every phase dispatch` observed token0 twice | Every begin increments control generation and records runner generation | PASS |
| Stale finish clears newer active-runner flag before fence check | HIGH: another worker may claim the supposedly free singleton slot | `does not let a stale finish release a resumed active runner` observed active1 -> 0 | `finish` first requires active runner and matching runner generation; only that runner may acknowledge stop, and revoked control cannot change phase/status | PASS |
| Recovery searches lowercase running while dispatcher writes uppercase RUNNING | MEDIUM: stale running rows survive reconciled recovery | `marks persisted uppercase RUNNING dispatches orphaned after proved owner stop` failed | Recovery now matches RUNNING and records ORPHANED | PASS |

An additional test, `refuses original implementation evidence as a new defect-fix receipt`, passed after the author correction. It is source-grounded coverage for the analogous `submitDefectFix` path; **no separate pre-fix failing run is claimed for this ninth test**.

### Execution evidence

Commands used native Node/Vitest and disposable SQLite/Git fixtures; no model or external service was called:

```text
node node_modules\vitest\vitest.mjs run tests\autonomy-core-review.test.ts --reporter=verbose
node node_modules\vitest\vitest.mjs run tests\autonomy-job-review.test.ts --reporter=verbose
node node_modules\vitest\vitest.mjs run tests\autonomy-core-review.test.ts tests\autonomy-job-review.test.ts --reporter=verbose
```

- 19:29:54 local: initial core **4 FAIL**, exit1; three unexpected successful submissions, one false process-error success.
- 19:30:53: corrected core **5 PASS**, exit0, including additional defect-fix coverage.
- 19:32:46: new job regressions **3 FAIL**, exit1; repeated token, stale flag release, untouched RUNNING row.
- 19:33:09: core **5 PASS / 1 FAIL**, exit1; newly reproduced abandoned-review acceptance.
- 19:33:48: combined **9 PASS**, exit0, two files, 3.26 seconds, after author fixes.

Focused tests run on Windows with synthetic fixtures; they do not certify the WSL driver or real model runtime. No full-suite result was independently run by this reviewer. Root reported broader checks separately; that report is not substituted for this focused evidence.

## Fix correctness review

- `requireLiveLease` rejects missing/invalid/elapsed grants at consumption. Controller author-submission and defect-fix paths now also check evidence provenance and current assignment; a valid lease alone no longer revives old evidence.
- Verification snapshots task attempt, token and revision before execution, repeats live authority/cleanliness checks afterward, and compares before inserting authoritative rows. A failed authority check may leave an unreferenced diagnostic artifact, but cannot create authoritative evidence or close work.
- Artifact files remain hash-checked before acceptance. Authority inside the artifact therefore cannot be altered independently of its recorded digest. Historical artifacts missing attempt authority fail closed on submission.
- Review/retest checks preserve separate reviewer identity and active REVIEW/RETEST purpose. Resume abandons old worktrees; those old receipts now fail current-assignment validation even when output revision is unchanged.
- All four engine execution phases now await `runAsync` and pass the abort signal. This removes the long synchronous acceptance command from the main engine path.
- JobStore extends existing tasks instead of maintaining a second task-status state machine. Transactional begin protects the singleton slot. Separate runner/control generations distinguish stop acknowledgement from authority to finish a phase: a revoked runner can acknowledge its own stop, but cannot release a newer runner or alter resumed work.
- `recoverStoppedOwner` remains a **trusted supervisor operation**, not a public cancel/status action. The stated precondition is independently proved old process-group/cgroup stop. These unit fixtures assume that precondition; they do not prove it. The method must never be exposed to model/tool callers as a way to clear an active owner.

## Remaining integration limits and concrete checks

1. **Execution isolation is not supplied by these core classes.** `VerificationRunner` still defaults to `processRunner()` with inherited environment, and legacy synchronous `run()` bypasses the injected runner. Current engine source uses `runAsync`, but the actual pilot must inject and exercise its isolated runner. Do not route user-controlled commands to either default path. The legacy method need not be removed for this bounded pilot if it is unreachable from pilot intake and its limitation is explicit.
2. **Owned process termination must be demonstrated.** `processRunner` has asynchronous timeout/abort and group/tree termination, but this review did not test escaped descendants, supervisor crash, cgroup stop or an OS kill failure. Root's proposed owned systemd group can supply that containment without another watcher. Distinguish logical revocation from observed process death before recovery/resume.
3. **Git inspection is still privileged.** Parent-side `git status`/`rev-parse` use synchronous Git helpers. Git commands are brief for these fixtures, but writable metadata can configure hooks/fsmonitor to execute under parent authority. Root selected controller-owned commits, keeping common metadata and the candidate `.git` pointer read-only. A follow-up WSL canary proved overwrite/unlink/rename/replacement denial and unchanged host hashes; see the isolation spike report. The actual commit wrapper's changed-path and parent-Git controls remain an integration check. Clean environment alone does not disable repository-local executable Git configuration.
4. **Intake actor provenance and immutable definitions remain trusted-caller responsibilities.** JobStore accepts an origin namespace as data; only the authenticated adapter may derive it. Its public-looking `row`, `definition`, `begin`, `finish`, and recovery methods are internal owner operations, not remotely exposed worker capabilities. Native specialist context must be frozen from approved sources before a job definition is persisted.
5. **No lifecycle inflation:** tests prove the specific late-result and evidence paths listed above. They do not prove approval callbacks, durable external delivery, restart through the full WSL driver, skipped-test/oracle protection, real independent repair or measured operator coordination reduction.

## Reviewer-authored files

- `tests/autonomy-core-review.test.ts`: six synthetic core authority regressions.
- `tests/autonomy-job-review.test.ts`: three job-generation/recovery regressions.
- This report.

Implementation author files were preserved; root made the fixes. Disposable test fixtures retain synthetic data only. No merge, deployment, service activation, credential change, external message or provider operation was performed.

Reviewed source hashes after the final green run: controller `A88DFF55A18DCB50E376A53EABDBF4122798DDE9146CFB8CF91E3FC90D00910A`; verifier `D8F8E5D502DF480AA450B11150372AD8A9A35C7BFC3798B62DF09E4FAF5FBF75`; JobStore `7AEE819145C7181AD1D6E2BEA0813884E8448FB89840DDF861591622090F8D83`. Later changes require affected checks, not a claim that this snapshot reviewed them.

## Appended driver, commit, decision and outbox review

Additional bounded scope: `src/autonomy/driver.ts`, `driver-lease.ts`, `isolation.ts`, `controlled-commit.ts`, `decisions.ts`, `outbox.ts`; existing decision/outbox tests were read and run. New owned file: `tests/autonomy-driver-review.test.ts`. No implementation files were edited by this reviewer.

### New reproduced defects

| Finding | Severity | Reproduction and consequence | Current disposition |
|---|---|---|---|
| Reviewer/retest prompt receives author-only implementation instructions | HIGH | Shared prompt concatenated `implementationPrompt`; real driver with fake review executor received `AUTHOR_ONLY_SEED_CANARY`, compromising independent review | Root split shared objective/context/acceptance from author-only directions; regression passes |
| Crash after engine terminal transaction but before driver finally loses notification | HIGH | Persisted VERIFIED + active runner with no outbox; proved-owner-stop recovery released ownership but produced zero notifications | Root added deterministic startup/outcome reconciliation keyed to status, generation and revision; regression passes |
| Trusted commit includes forbidden pre-staged content | HIGH | Forbidden file staged before wrapper plus allowed unstaged edit; wrapper validated only modified/deleted/other files then committed both | Root now rejects nonempty index before accepting worker edits; regression passes |
| Restart silently resumes an explicitly paused job | HIGH | Begin -> operator pause while runner active -> owner death before acknowledgement -> proved-stop recovery changed PAUSED to READY | Reproduced and sent to author; fix/rerun pending at this checkpoint |

The initial prompt test hit a newly added oracle-path/hash guard rather than reaching review. Its fixture was corrected to a valid frozen `oracle.mjs` and hash; the subsequent failure was exactly the author-context leak. No false claim is made from the preliminary fixture failure.

19:41:57 local: driver-review **3 FAIL**, all three initial defects observed. 19:42:48: driver/decision/outbox **36 PASS / 1 FAIL**, with only terminal notification reconciliation still pending. 19:44:50: expanded driver-review **7 PASS / 1 FAIL**, with only lost operator pause failing. 19:45:18 combined review/core/job/decision/outbox checkpoint: **50 PASS / 1 FAIL**, five files; lost pause remains the failure. Commands use the same native Node/Vitest pattern and no provider call.

### Additional passing assertions

The expanded driver tests confirm terminal cancellation survives owner recovery, persisted emergency stop survives database reopen and blocks engine dispatch, exhausted phase budgets are not reset by restart, and a foreign origin cannot cancel the task. These are controller-local state tests; actor identities are synthetic trusted inputs, not Telegram authentication proof.

All **20 existing decision tests** and **14 existing outbox tests** passed in the independent focused run. They cover exact-action/source binding, actor denial, expiry, one-use consumption, denied actions, interrupted/ambiguous effects, durable retry bounds, idempotence and forbidden destination metadata. Their injected effect/sink contracts remain controller-local. The real adapter must derive identity, enforce its own bounded timeout/cancellation and never convert a skipped/ambiguous send into successful receipt. No live callback, model authentication or delivery was exercised here.

### Source-grounded follow-ups before stronger acceptance

- **Commit revocation window:** the original wrapper checked only an AbortSignal updated by the driver's 100 ms poll. Database cancellation followed by a fast model completion could reach trusted commit before the signal changed; final dispatch acceptance would reject only afterward. Root plans a synchronous, exact-current-dispatch authority check and commit within the same serialized database transaction. This concern is source-grounded, not yet a separately reproduced race. Require a regression proving cancellation-before-commit produces no commit. Bound the whole critical section, and distinguish WAL reads from same-process event-loop responsiveness when synchronous Git runs.
- **Process-group recovery:** DriverLease records PID/start/boot/cgroup identity and refuses a live old owner or an unsupervised interrupted group. The tested DriverLease is mocked solely to assert the already-proved-stop precondition. Real cgroup destruction/descendant checks remain untested. `cgroup.procs` alone does not include nested child groups; if nested groups are possible, inspect descendant population or enforce the actual supervisor's recursive kill/wait contract before takeover. Do not interpret boot-ID change as a general cross-host coordination scheme.
- **Oracle and configuration boundaries:** the driver now validates a fixed basename and protected oracle hash before dispatch. The exact registered oracle's dependencies and any project `.codex` settings must remain approved/frozen; `--ignore-user-config` alone is not all project-config isolation. Worker Git metadata read protection was independently canary-tested in the separate spike; actual native-auth execution still needs its own evidence.
- **Crash delivery semantics:** deterministic reconciliation is an appropriate small repair for the terminal/outbox transaction gap. It must remain idempotent across repeated startup and not overwrite terminal truth. This is durable at-least-once notification state, not exactly-once physical Telegram delivery.

The smallest architecture remains sound after these narrow repairs. No additional orchestration framework or production cutover is requested by this review.

### Subsequent pause and commit-gate checkpoint

The pause-preservation repair landed: recovery now clears stopped-runner ownership while preserving explicit PAUSED and terminal state. The targeted pause/cancel/emergency/budget/origin tests pass. A trusted commit closure now captures task/dispatch/actor/attempt/lease and runner/control generation before model execution, checks them again immediately before commit, and limits the Git command sequence to one shared five-second deadline. Two new tests confirm both pause and cancel immediately before closure invocation prevent the effect without waiting for the 100 ms signal poll.

**New HIGH finding, reproduced 19:48:35:** placing the effect inside the default `FactoryDatabase.transaction` did not acquire a write lock before the effect. Better-sqlite3's deferred transaction read the grant, then performed the filesystem effect, then attempted its first database write for audit. A second real SQLite connection could successfully cancel the task during that read transaction. The late audit could fail after the effect had occurred. The new regression `holds a SQLite write lock before any trusted commit side effect` failed: `competingCancelSucceeded` was true. This uses a real WAL database, second connection with one-millisecond busy timeout, and a synthetic effect callback; no Git/provider/external effect is involved.

Required narrow fix: start an IMMEDIATE transaction, or acquire a verified write/CAS lock before invoking the effect. Root selected explicit `.immediate()`. The regression must prove the racing second-connection cancel is blocked while the effect executes, the current task stays RUNNING during this critical section, and the commit audit completes. The optional `commitGate ?? commit` fallback should also be removed for write workers; otherwise callers that omit the gate silently bypass revocation checks. Read-only canaries do not need a commit gate.

At 19:48:35 the targeted driver checkpoint was **10 PASS / 1 FAIL**, with this cross-connection lock race the sole failure. Root then changed the commit critical section to `database.raw.transaction(...).immediate()` and added a pre-provider failure for write workers missing the trusted gate. Both changes were directly inspected.

### Final focused checkpoint for this review

At **19:50:22 local**, the independent combined command passed **54/54 tests across five files**, exit0, 3.17 seconds:

```text
node node_modules\vitest\vitest.mjs run tests\autonomy-driver-review.test.ts tests\autonomy-core-review.test.ts tests\autonomy-job-review.test.ts tests\autonomy-decisions.test.ts tests\autonomy-outbox.test.ts
```

This includes the real two-connection write-lock regression, immediate pause/cancel-before-commit tests, pause preservation, terminal/outbox crash reconciliation, blind-review separation, staging refusal, emergency persistence, budget/namespace denial, and the earlier core/job/decision/outbox guards. The reviewer authored 20 of these tests; 34 were existing decision/outbox tests. The implementation owner must still review reviewer-authored tests independently.

**No reproduced finding remains open in this bounded test set.** Proceed to the separate actual-supervisor/worker/adapter harness. Runtime process death, exact loaded tool permissions, provider authentication, native host differences, live delivery and measured autonomy benefit remain outside this green checkpoint. No model/provider or external message was used by this review.

Final source SHA256 snapshot: `driver.ts` A699A3C804004DAE8F1C0A22C6DE53C08E828BD86F92D0FAC9957CD75A133BC4; `driver-lease.ts` CD6DA652A79AE0B0847A73BBB3A32FEB818BFD953864C44BEBD2B5A01B803893; `controlled-commit.ts` 7B852A098572EF2172137A0E99A9C3874FF31AC9CBBC3583499DBB0E52578547; `isolation.ts` 1F9BB23269F0984FF4646B64ABD7E047F4F6EBD7444F324671FF7770EB6A6676; `job-store.ts` BFA372A763C887F39344C30F49CA74EBC4AE47867FAED6611625FE0ED4C2FF65.

## Appended protected fixture acceptance review

Bounded additional scope: `src/autonomy/bootstrap.ts`, `src/core/current-evidence.ts`, four protected fixture oracles and existing bootstrap tests. The reviewer added five adversarial tests to the already owned `tests/autonomy-driver-review.test.ts`; no source or fixture files were edited by the reviewer.

At **19:57:50 local**, three real oracle attacks returned exit0 incorrectly: CRM candidate monkeypatched `JSON.stringify` and mutated the input; CRM candidate printed forged probe JSON and exited without the required export; an infra report gave correct queue counts and then contradictory Pending: 999 / Running: 99 labels. All three tests were RED before the author's fix.

Root repaired CRM execution with a fresh null-prototype VM realm inside the existing bounded child process, disabled string/Wasm code generation, rejected imports, required the actual export, deep-froze supplied input and serialized validated original-record references from the trusted realm. VM separation protects this oracle protocol; **it is not an OS sandbox or provider confidentiality proof**. Parent process status and process errors both remain mandatory. Infra queue labels now require one exact canonical value.

At **20:01:16 local**, independent command `node node_modules/vitest/vitest.mjs run tests/autonomy-driver-review.test.ts tests/autonomy-core-review.test.ts tests/autonomy-bootstrap.test.ts --reporter=verbose` passed **28/28 tests**, exit0. This included all three repaired attacks, six current-evidence regressions and eight bootstrap/fixture checks. Direct source inspection confirmed the `current-evidence.ts` extraction preserves active-assignment, actor, task, attempt, implementation lease digest, exact HEAD and clean-worktree checks. It must still be called only after artifact hash/producer/kind validation, as the controller does.

At **20:02:30 local**, two further narrow document attacks were reproduced: contradictory later API: HEALTHY / Database: OFFLINE / Backup: VERIFIED labels in an otherwise valid infra report, and final Verdict: PASS following Verdict: NEEDS_WORK in an otherwise valid design review. Both returned oracle exit0. Command `node node_modules/vitest/vitest.mjs run tests/autonomy-driver-review.test.ts -t 'contradictory' --reporter=verbose` reported **2 FAIL / 1 PASS / 13 filtered skips**. These findings remain open at this checkpoint; the narrow repair is exactly one canonical expected probe/backup/verdict label, mirroring queue-count handling.

Static source observations: bootstrap preserves existing allowed output while refusing changed fixed inputs/oracles, unrelated directories, symbolic links in controlled fixture paths, wrong Git-root ownership and altered actor capabilities. The current design fixture now contains render images and a manifest, but its current oracle still accepts the existing test text saying no screenshot was supplied. Actual image consumption and render proof remain root's separate active work. Document regex criteria cover known factual boundaries; they do not constitute exhaustive semantic review or measured design quality.

Source snapshot after the 28-test checkpoint: bootstrap `AF5A4D53C66596D69F9F4DB3B6115EC9B2CAD72E3F4267639D576E9E40406981`; current-evidence `B25D672AD6A0E52BC9622E9FAA9F66F6CE31FFEC8E0C9A82FEC4D7341815F2C8`; CRM oracle `73F68F0F7549F7EFFE8768930D13C1E1BD998F48CCC9ECF2B006B90E97306FD5`; infra oracle `8CC4527A1642A3BE72CC02CEA12F5F31AAB7471A3ED13532FCD0AA5EE88F3C16`; design oracle `B5DD84AF786733670D7244207EF2CD760680E0F444D01A56A9D5E4022F29F549`.

### Final protected-fixture checkpoint

Root added exact single-label checks for API, Database, Worker, Backup and design Verdict. The two new regressions were strengthened to first assert that their valid baseline passes, then append only the contradictory text and require failure. At **20:04:06** the three selected contradiction regressions passed; this is not a false green caused by a missing fixture or an unrelated rejection.

At **20:04:19 local**, the independent combined run passed **67/67 tests across six files**, exit0, 10.04 seconds:

```text
node node_modules/vitest/vitest.mjs run tests/autonomy-driver-review.test.ts tests/autonomy-core-review.test.ts tests/autonomy-job-review.test.ts tests/autonomy-decisions.test.ts tests/autonomy-outbox.test.ts tests/autonomy-bootstrap.test.ts
```

Counts: reviewer-owned core 6, job 3, driver/fixture 16; existing decisions 20, outbox 14, bootstrap 8. No reproduced finding remains open in this bounded checkpoint. The source/protocol tests do not establish provider isolation, native model execution, live delivery, consumed-image evidence or general document truthfulness. The small fixed CRM dataset is still vulnerable to overfitting in principle; held-out input variation would support stronger behavioral generality claims.

Updated SHA256: infra oracle `6E7336B80739CA4FF14196A98225FB713DAF10C3E667D8591A292B67B1CD6D5D`; design oracle `7ECA363B8CF852D6EF5BEAA14892C1AD6EB1F1A73BCC830B8DE86D1869CC4A2F`; reviewer driver tests `355D4290517273CBE06EA39C3EF96E2EDA2A28FFD21763D7FDE272542F501667`.

## Appended backup, notification, CLI and image-argument review

Final bounded additional scope: `backup.ts` and its tests, `notification-sink.ts`, CLI run/deliver/backup/restore wiring, process-runner stdin, frozen worker image arguments and JobStore accepted-artifact projection. Only high-material findings were sought. The reviewer edited only the already owned driver-review tests and this report; root/backup owner made implementation changes.

### Reproduced restore notification resurrection

At **20:12:26 local**, a real AutonomyDriver invocation over the exact delivery-relevant restored state was RED. The fixture had global stopped=1, a prior VERIFIED notification marked UNCERTAIN and the control generation incremented as `rebaseAndStop` did. Driver reconciliation generated `VERIFIED:1:<revision>` as a new transition and invoked the fake sink once. This bypassed the intended restored delivery stop and could resend historical outcomes. The reproduction modeled the exact restore SQL state; it did not invoke Telegram or claim an actual provider delivery.

The narrow repair adds durable `outcome_delivery_hold`, set to 1 for every restored intake and defaulting to 0 for new intakes. Driver refuses an initially stopped pilot, suppresses reconciliation/enqueue for held rows and checks stopped state during delivery loops. The trusted notification sink rejects stopped or held rows before spawning a notifier; CLI deliver also refuses the stopped root. Existing notice history remains intact, and simply enabling a restored root does not authorize replaying its historical outcomes.

The strengthened reviewer regression now checks stopped-run rejection with zero sink calls, then clears the global stop and requires phases=0, no new outbox row and no historic sink call. It also directly invokes the sink for a held row and requires non-retryable not_sent with zero process invocations. At **20:14:53**, this regression and the existing explicit emergency-stop regression both passed.

### Verification and practical limits

At **20:15:15 local**, command `node node_modules/vitest/vitest.mjs run tests/autonomy-driver-review.test.ts tests/autonomy-backup.test.ts tests/autonomy-notification-sink.test.ts tests/codex-worker-options.test.ts tests/codex-worker-cancellation.test.ts` passed **40/40 tests**, exit0, 21.73 seconds. Counts are driver/fixture reviewer 17, backup 6, notification sink 7, worker options 7, worker cancellation 3. The earlier pre-fix run of the existing four new-scope files passed 22 tests; that did not detect restore reconciliation, illustrating why the separate regression was required.

Backup tests use real SQLite, controller receipts and Git revisions. They verify integrity/FK checks, stopped restore, held old decisions/notices, preserved accepted revision/evidence bytes, exact actor/attempt binding, refusal of active owners, dirty outputs, corruption, missing evidence, wrong manifest anchors, overlap and existing destinations. The scripted worker in those tests establishes controller transport/receipt behavior only; it does not establish product quality or native provider success.

A separate actual CLI rehearsal ran current TypeScript source through tsx in a fresh disposable local pilot: init -> backup with four repositories -> restore requiring the returned manifest digest -> health. Results: database ok, enabled=false, activeWorkers=0. Deliver on that restored root rejected with `Pilot is stopped; outbound delivery is held` before reading a deliberately nonexistent notifier configuration. It created no task, worker or notifier. The backup contained zero acceptance artifacts because this rehearsal validates CLI wiring; the six backup tests cover populated evidence. Rehearsal manifest digest: `7601e7bb54e458e22a8fe1d1f18407a289ee575f34d65cc7f6eb934487d82664`.

Notification receipt acceptance requires exact event ID, success exit, delivered=true and a numeric Telegram message receipt. Timeout, input/process errors, skipped replies, wrong events and malformed JSON remain uncertain. Literal stdin was verified through a real local process without a shell. The image options test proves copied immutable `--image` arguments; source inspection confirms path/hash validation and the required write commit gate. It does not prove a native provider consumed or understood the screenshots. JobStore projects only an allowlisted output from the recorded VERIFIED Git revision, with a 16 KiB process buffer limit; the adapter owner's actual-RPC test for a changed worktree was inspected, not rerun by this reviewer.

**No reproduced material finding remains open in this bounded review.** Runtime provider isolation, live POSIX notifier configuration and actual external delivery/owner receipt remain separate gates. No model or external message was invoked by this review. Reviewer-authored tests now total 26: core 6, job 3, driver/fixture/restore 17; the implementation owner remains responsible for independent review of those tests.

Final SHA256 snapshot: backup `22EA661A3A18C871D28EA812C785D7487D0C092AC18B5C2C32AF5AF1EC39B19E`; notification sink `EC23E66A7EBB9B20BCDE67E5EB95DD7705626D12190CAD4A32F458566ECE7E94`; CLI `97D5AFB5FB00CD35318A43A8681BA62E3E3C13962F67683DF643517A34B0C203`; process runner `5561A0DB371D44F684779CD3041E8F43F0890561CD76F314CF551F3F097990CC`; isolation `BA081ABAA575D279B2099DE9D8330DABBA1CDD0DCB79801F1318D0EED12F7BDD`; driver `C8B85065B789E42D62B4292D1BF7E4D69D72783773F02DBB81CBFF784DBA7761`; JobStore `01B0C5E5DCEE470BE4FE1C23BCB1F3C905724103B5539359F6F644ABC1EBEAB6`; reviewer driver tests `C5BD66ADD7A22AB3F2663E4076464275B857FF59318EC7AB04287B5046CA00C2`.

## Final read-only operator, service and scripted-loop acceptance review

At **20:24 local**, reviewed current `docs/AUTONOMY-PILOT.md`, `ops/autonomy-pilot.service`, four fixture oracles, `tests/autonomy-loop.test.ts`, relevant CLI/driver lease code and the design capture manifest. Source/test files were read only; only this review report was updated. **No new reproduced material finding or unsupported readiness claim was found within this bounded scope.**

The operating guide distinguishes implemented local mechanics from native-provider acceptance, keeps the VM explicitly separate from the OS isolation boundary, identifies non-code criteria as bounded checks requiring semantic review, and labels the one historical Telegram receipt as route evidence without owner-read/outbox proof. Its four-dispatch job and twelve-dispatch persisted aggregate limits, fifteen-minute CLI deadline, restored delivery hold and stopped delivery behavior match the inspected code.

The prepared service's `--idle-ms 900000` matches the current CLI bound. The unit has control-group kill, a ten-second stop grace, fifteen-minute RuntimeMaxSec, restart-on-failure and three starts per two-hour limit, without an Install section. Offline `wsl.exe -d Ubuntu --exec systemd-analyze --user verify /mnt/g/tmp/finalorchestra-autonomy-20260907/ops/autonomy-pilot.service` returned **exit0**. It warned that the source file on the mounted Windows filesystem appears executable and world-writable, then continued. This is syntax/dependency inspection only. Installation permissions, actual user-unit resource/isolation compatibility, complete group death, crash recovery and restart remain required host evidence. No unit was installed, started, enabled or restarted, and no permissions were changed.

The scripted-loop test invokes four real driver `step` calls using real Git, SQLite and protected oracles, with a scripted worker that first introduces an ID-prefix defect and then repairs it. Assertions cover REVIEW -> DEFECT -> RETEST -> VERIFIED, four dispatches, one closed defect, two evidence revisions, one terminal outbox entry and origin-bound accepted artifact retrieval. It deliberately does not exercise native provider behavior, independent semantic judgment, `run()` ownership/supervisor recovery or OS sandboxing; its comment states that limitation. The root's separate final test run owns the current execution result; this final pass inspected the test rather than repeating the full suite.

The latest CRM oracle now includes alternate supplied records (including changed contents under an existing customer ID) and checks frozen input preservation, resolving the earlier fixed-dataset coverage limitation noted above. This remains bounded behavioral coverage, not exhaustive generality. Existing non-code oracles keep exact single-value infrastructure/verdict guards; consumed-image proof and broad document truthfulness remain explicitly unfinished gates rather than properties inferred from regex checks.

Read-only hash verification matched both PNG captures and the HTML source to `render-evidence.json`: desktop 1440x1000, mobile 390x844. Manifest interaction status remains `not run; static review fixture`. This verifies artifact binding; no screenshot was re-rendered and no provider image-consumption claim is made.

Remaining mandatory gates are unchanged: working chosen-host egress and authenticated isolation canary; four provider-backed jobs with an actual rejection/repair cycle; consumed-image evidence; live owner intake and exact outbox/provider receipt; supervised kill/recovery/restart/stop; and the observation window. No model or external send was invoked by this review.

Snapshot SHA256: operator guide `778C2EA4437B32B35EA6AD53A33127AADF9F311CDF22C17946B675E8BD1A1954`; service `99FD1C2C49E7E2A155F8F9B53D9BF2DA8074C68F6E100C61E5E5D21ACDFCED1C`; scripted loop test `EFF702F8FE9862DBB9C431D64F47FBD981F091E66F41DCA4CC91093886108356`; CRM oracle `8505669CC264C9B077B7FCBDF8D8860E986D68030B2148B551C3DC61AB8869CA`.

<!-- doc-head: Independent T-0418 waker outcome and continuity acceptance -->
Accepts the local source, bounded review dedupe, deterministic replay, and fixture repair at the hashes below.
Bare turn boundaries stay quiet only after fail-open graph, Fleet, context, composer, and receipt checks.
This is source and recording-sink evidence; the running daemon was not activated or changed.
<!-- /doc-head -->

# T-0418 independent waker review

## Verdict

**Accepted for local atomic commits, within the limits below.** The waker candidate removes false coordinator wakes from ordinary turn boundaries while preserving concrete results, A2A, real permission waits, open graphs, recovery riders, and new or changed review obligations. It never treats a wake receipt as task completion and does not mutate Fleet cards, `next_action`, graphs, results, rulings, or the live daemon.

The suppression predicate is narrow. A repo group can be consumed without a prompt only when every intent is `turn-end`, graph state is positively closed/absent, the strict Fleet snapshot is readable, every same-repo nondeferred review obligation has already been named at its current meaningful version, context is below the configured watermark, and no source composer retains text. Result files, directed A2A events, non-bypass permission waits, open graphs, high context, and held composers remain actionable regardless of review-receipt state.

Review receipts reuse the existing delivered ring. Their stable SHA-256 input includes card identity, repo/state/correlation, `next_action`, blocker/binding fields, evaluator evidence, context references, acceptance criteria, and same-task rulings. Routine timestamps and leases do not churn the receipt. An unchanged review card is named once; changed evidence or a changed ruling mints a new receipt and wakes again. Unreadable rulings produce no stable key, so they never authorize dedupe silence.

Suppressed and verified-send IDs are persisted to `delivered.json` before removal from `pending.json`. On construction, an ID present in both files is removed from pending. Two child-process killers exit immediately after the atomic delivered receipt rename and before pending removal: one for suppressed noise and one after one verified recording-sink send. Reconstruction removes the overlap without another send and without changing the task. No new watcher, queue, backlog, state file, model call, or live sender was added.

## Fleet and graph semantics

The strict read-only Fleet reader reuses `reviewWakeTargets`, including its latest-ruling and live-deferral rules. It enumerates every task JSON and returns unknown on parse errors, ID/filename mismatch, unknown state, a noncanonical active file, or a nonterminal card without a repo. The measured historical `T-LOOP-STALL.json` shape is ignored only after its object, matching ID, and known `done`/`cancelled` state validate. Changing that same file to `review` or `ready` prevents suppression.

Graph inspection is tri-state. Missing `.orchestrator` means no graph; a valid graph with a runnable node means open; unreadable or malformed graph data means unknown and preserves the wake. The unknown message says `Graph status unavailable` and never claims absence was confirmed. Ten current brlite graph files were inspected read-only and all had nonempty node arrays, so the malformed-object guard contradicts no measured graph shape. An explicit empty node array remains closed because it contains no runnable node; an independent review card is still checked.

## Exact accepted files

- `src/orchestrator-waker.cjs` — SHA-256 `4BF1159FD43E8CCFB218F2416BEB6681090A40929D83AEEEC33070FD9C6C2685`.
- `scripts/orchestrator-turn.cjs` — SHA-256 `052AACB6669238C0503865241E1B0105EC560D2181A6E8D179DB7D984F915787`.
- `test/waker-outcome-obligation.test.cjs` — SHA-256 `57CB68ABC6AB1E9330088AC08A495305760D79AB3F49BBAD4E0661802E358EE5`.
- `scripts/waker-outcome-replay.cjs` — SHA-256 `DDB1D01FB0E12D3B54EEFC2ED2542C49165F9E7C3C5E9FD7D1BF662FEAE81A00`.
- `test/tasks-watcher.test.cjs` — SHA-256 `777BCD2C6E35E08DCCD6EFC4348C2476B22CF111C9579FFE2D5CFFE27C24F1B5`.

The `tasks-watcher` change is accepted as a separate test-only commit. The suite preload replaces `WEZBRIDGE_WEZTERM_BIN` in child processes; the fixture now resets it after preload to a unique nonexistent path under its temporary directory. This restores the intended unreadable-pane case without changing production watcher code.

## Independent verification

- Final core waker, liveness, transport, deferral, ruling, dedupe, and forced-exit suites: `105/105` passed. Log `G:/tmp/T0418-waker-independent-core-v2.log`, SHA-256 `0516C23A0DFDC3D4EB3B37129683A74B086CE2649071F6D4B6B9EEFFBE66ADCC`.
- Watcher fixture plus no-new-coordinator guard: `22/22` passed. Log `G:/tmp/T0418-waker-independent-fixtures.log`, SHA-256 `369648BDBAF46DB20B16289F99FAE3C80F00B5978DADD0B6D083FB5F6F2F7CA9`.
- Final full `npm test`: 1,320 tests, 1,293 passed, 27 skipped, zero failed. Log `G:/tmp/T0418-waker-full-accepted-candidate.log`, SHA-256 `5CD87D289C3CDFFD296B130CDF735CECB7789C9439317F2D885A6F92E633350E`. The isolated full gate used an exact nonsecret affinity fixture copy at `G:/tmp/_intel/affinity.json`, SHA-256 `F1A0251C42254386A4A865CB19CC173D9030528C7B2C4574CC21C24AC91BD885`; no live registry was changed.
- Node syntax checks passed for both source files, the replay, and the outcome test. `git diff --check` passed; only line-ending conversion warnings were printed.

Twelve independent mutations ran in a disposable archived scratch copy. The unmodified control passed, and every mutation failed the focused suite: disabling noise suppression; removing restart overlap reconciliation; ignoring review obligations; ignoring context/held riders; suppressing hard signals; allowing ledger uncertainty to authorize silence; treating malformed graph data as closed; allowing an active noncanonical card; disabling stable review dedupe; omitting evaluator evidence from the review key; withholding the review receipt after a verified prompt; and restoring pending-before-delivered persistence. Result artifact `G:/tmp/T0418-waker-inverse-results-v2.json`, SHA-256 `95D105FAAB0AC761B27A2108DB99DE534A9D8723A8AC9EDBD76448B0215E9207`. The scratch checkout and archive were removed afterward.

## Concrete local replay

The finite replay copied the current task/ruling/graph inputs, selected two exact existing turn-end events, used an in-memory recording sink, and reconstructed the waker over the same durable state. Baseline source `b6f8e6c` produced two initial prompts and four after simulated subsequent new turns. The candidate produced one initial useful prompt naming graphless review card `T-0330`, stayed at one after reconstruction, and remained at one after the simulated new turns. The MemoryMaster boundary stayed quiet. `actualMessagesSent` is zero.

Artifact `G:/tmp/T0418-waker-real-events-final-v2.json`, SHA-256 `34484A21D1A561C0D19C896DFA78F3D0DD3C7D60D60E491418A1BECA9431A1BA`, binds the candidate waker hash and baseline source hash. An independent read confirmed both exact events occur once in the source event log. It also confirmed `T-0330` is currently a `review` card for `whatsappbot-final` with a populated operator-gated `next_action`. The card predates and is not correlated to the selected Wabot turn; this is why stable review-receipt dedupe is required after the first reminder.

## Limits

The replay uses a current copied ledger and graph snapshot. It does not reconstruct historical state at each event, bind every copied input file by hash, or include live source-pane context/composer state. Context and held-composer preservation are deterministic-test evidence.

The delivered ring retains 500 entries. Review dedupe therefore survives restart only while its receipt remains inside that bounded history; this is not indefinite global exactly-once delivery. A process death before the verified delivered receipt is persisted can still cause a retry, because no durable system can infer that an unrecorded external send succeeded. The forced-exit proof begins after receipt persistence and proves no duplicate from that point.

No prompt reached WezTerm, no daemon was restarted or reloaded, no scheduler or service changed, and no live delivery, live process restart, soak, or operator acceptance is claimed. The candidate remains source on disk until separately authorized runtime activation loads it.

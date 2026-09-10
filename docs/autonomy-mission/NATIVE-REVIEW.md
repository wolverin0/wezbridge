<!-- doc-head: Bounded post-fcb6662 native isolation and oracle review; no material weakening found -->
Read-only review of named-profile/TOML transport, synchronous oracle completion and two native rehearsal scripts.
Six JavaScript syntax checks passed; no canary, model worker, service or external send was executed by this reviewer.
Graceful-pause checkpoint: Docker recovery is incomplete and unaccepted; three of seven new tests failed and no actual kill/recovery run occurred.
<!-- /doc-head -->

# Bounded verdict

Reviewed the uncommitted diff after `fcb6662` in the owned native worktree at 2026-09-07 23:51 Argentina time (2026-09-08 UTC). Scope was `src/autonomy/isolation.ts`, four protected oracles, `scripts/autonomy-native-isolation.mjs`, `scripts/autonomy-real-crm.mjs` and the associated explicit native-test package command. **No material acceptance weakening or reproduced isolation bypass was found in this diff.** This is source review plus syntax validation, not an independent rerun of the new provider evidence.

The inline TOML filesystem table preserves full paths, including dots, as quoted keys inside a value rather than exposing them to the override-key splitter. The actual verifier invocation now selects `-P autonomy-verify` explicitly and retains the intended minimal/read-only paths and disabled network. Empty stdout with exit0 is now rejected. Existing timeout, cancellation and process-error failures remain intact.

All four oracles retain their prior assertions, criterion counters and final exit-code decisions. `fs.writeSync(1, ...)` changes completion transport to a synchronous write; it does not remove criteria or accept a failed probe. The CRM child receives no stdin, still receives its controlled JSON arguments, runs the candidate in the separate VM realm with frozen inputs and rejected imports, validates original record references and requires both successful child status and no process error. Outer parent assertions remain protected.

# Script proof boundaries

The native model-free script creates disposable paths, requires Linux, directly exercises the real isolatedVerifier and demands: supplied-file read succeeds; private read and candidate write are denied; network fails with EACCES/EPERM. A timeout or other network error is not relabeled as denial. It separately rejects a quiet exit0 command. Its PASS is limited to those observed verifier conditions; it does not establish native worker write permissions, every protected Git-metadata operation, provider authentication or supervisor recovery.

The real-CRM script requires an explicit model opt-in and an owned `/pilot/` root, performs a protected-oracle preflight, and uses the native IsolatedCodexWorker, real driver, current commit-authority gate and isolated verifier. Its fault injection is explicit controller-side rehearsal code: it saves the original artifact and hashes, injects the bounded ID-prefix fault under the authority gate and lets ordinary independent review/repair act on it. This supports a controlled fault-recovery claim; it must not be described as a naturally occurring defect authored by the first model. The final assertions require VERIFIED, four accumulated dispatches, a recorded FAIL review and at least four distinct thread IDs. Its fixed origin key intentionally reuses durable job history, so a repeat invocation may inspect an already completed job; the report's phase count and persisted dispatch evidence distinguish this from a newly executed cycle.

The root reported a passing scoped Docker model canary, a four-thread CRM rejection/repair result and durable outbox receipt 39805. Those runtime artifacts and external receipt were not reopened or independently reproduced in this narrowly requested diff review. The reviewer makes no additional provider, delivery or owner-read claim from the scripts alone.

# Verification performed

`node --check` passed for both new scripts and all four changed `.mjs` oracles: six syntax checks, exit0. The scripts were not executed. No source, test, credential, permission, service or provider configuration was modified. Only this report was written.

SHA256 at this checkpoint:

- isolation.ts: `D6857A4C96F7293F13393EA011D19C87F388D7F18BE8EE3CECF6B20E1A0A09EA`
- autonomy-native-isolation.mjs: `1AF6355388EBC005E5AB3982FEBCA4ECA2B6A0203CA630981358E65A16E58259`
- autonomy-real-crm.mjs: `5F8946685802EAC0D842D19A391E2DE0F059EDCE4D651DA292D6397BD3899A17`
- crm_search.mjs: `C133F6094D5406B6930E959C2277B95516203E6447FB8153202954EF64C9F05D`

# Separate Docker recovery proposal

Root subsequently proposed a narrow replacement-container path using a read-only host cgroup2 view. Conditional design assessment: the stored and current identities must bind the same boot and cgroup-namespace inode; both group paths must match the exact supported Docker shape; groups must differ; the current group and actual cgroup2 mount must be verifiable. Same-container restart, malformed or unreadable evidence and unknown namespace/mount conditions must fail closed.

Use hierarchical `cgroup.events` populated=0, never an apparently empty `cgroup.procs` across PID namespaces. An absent prior group path proves anything only under that same verified host view. Group emptiness also relies on prior containment preventing worker migration outside the group; it cannot prove that an already escaped process died. Actual survivor rejection and stopped-predecessor recovery remain required. No Docker-recovery implementation or runtime acceptance is granted by this proposal assessment; root said source and tests would follow separately.

## Graceful-pause checkpoint

The operator requested a graceful pause while this bounded report was being finalized. Root reported that the seven new Docker-recovery tests had three failures caused by Windows-path mocking; fixture path handling was not yet repaired at this checkpoint. No actual cgroup kill, survivor-rejection or stopped-predecessor recovery run occurred. **Docker recovery remains INCOMPLETE and UNACCEPTED.** These test results are root-reported, not independently rerun here. The reviewer stopped without any additional review, test, worker or external action.

<!-- doc-head: T-0418 local evidence and open live acceptance, 2026-09-07 -->
Includes final Linux signal-race correction, local commit/index scope, provider, Telegram and supervisor gates.
Read before acceptance; implementation is locally verified, autonomous live outcomes remain unproved.
<!-- /doc-head -->

# Acceptance matrix

| Criterion | Result | Evidence/limit |
|---|---|---|
| Windows Node | PASS | npm test at23:23:44UTC:127 pass,1 explicit provider skip;21.90s;exit0. |
| Linux Node | PASS | Current owned source at23:25:48UTC:127 pass,1 provider skip;10.44s;exit0. |
| TypeScript/build | PASS | npm run check and npm run build exit0; lock unchanged. |
| Hermes adapter | LOCAL PASS |45 distinct cases:Windows43 pass/2 POSIX skips,WSL42 pass/3 Windows CLI skips. Latest Windows run11.175s. Fixed owner/context/namespace and actual CLI/artifact retrieval. |
| Full engineering driver | SCRIPTED PASS | Real Git/SQLite/oracles:REVIEW->DEFECT->RETEST->VERIFIED;4 dispatches,2 revisions,1 closed defect,1 terminal outbox entry. No model/supervisor proof. |
| Authority | LOCAL PASS | Lease expiry/replacement,actor,attempt,worktree,revision/hash checks; stale/aborted observations refused. Commit effect inside immediate SQLite authority transaction. |
| Decisions | LOCAL PASS |20 tests bind harmless receipt to owner/action/scope/artifact/expiry/one use. No live human callback. |
| Notifications | LOCAL PASS |14 outbox+7 sink tests; bounded backoff,literal stdin,exact receipt,uncertain hold. Live outbox delivery OPEN. |
| Backup/restore | LOCAL PASS |6 real SQLite/Git/receipt tests plus actual CLI init->4-repo backup->stopped restore->health. Historical delivery stays held after enable. |
| Independent acceptance | BOUNDED PASS | CORE-REVIEW retains red findings and fixes;67-test core/fixture checkpoint,40-test backup/notification checkpoint;final operator/service review found no new material issue. |
| Supervisor | SYNTAX ONLY | systemd-analyze --user verify exit0 with source Windows-mount permission warnings;no install/cgroup/kill/reboot proof. |
| Command isolation | PARTIAL | WSL restricted roots/network/Git pointer passed;Docker verifier probe passed. Windows private read allowed;server namespace denied;fallbacks rejected. |
| Authenticated isolation | BLOCKED |2 Codex0.153.4 cloud-config failures before thread;later default/IPv4 curl28. Effective model MCP/hooks/native-file boundaries unverified. |
| Infra/marketing | FIXTURES ONLY | Frozen facts and negative checks pass;no model-authored live diagnosis/draft accepted. No mutation/publication. |
| Design | RENDERED | Chrome1440x1000 and390x844 screenshots match hashes;root saw weak CTA contrast/small text. Image consumption,keyboard/a11y and semantic acceptance OPEN. |
| Existing Telegram route | SENT |1 authorized harmless native Hermes send,receipt39790;not owner-read,plugin/intake/outbox proof. |
| Scoped memory | PARTIAL | Existing governed recall callable;pilot freezes fixture context. Live retrieval,contradictions/customer separation OPEN. |
| Soak/benefit | UNMEASURED | No installed pilot/elapsed window;no time-saved or reliability claim. |

## Retained real job trace

ENGINE-INVENTORY.md checked R5 job JOB-9b24bf46-b856-496c-af09-3ca046735d1c. Started2026-09-06T18:10:44.790Z; retained its Foreman session through injected lease expiry; hit snapshot-storage quota402; cancellation requested18:18:54.652Z; CANCELLED18:19:08.313Z. No final commit,all4 criteria BLOCKED. Hashes were checked read-only; not a new live run.

This supports persisted recovery evidence, not accepted useful output. An operator/agent still needed to interpret quota and cancellation evidence. The retained artifact does not identify every human transition, so no intervention count is assigned. The new driver internalizes phase routing/repair deterministically; actual attention savings still require comparable real jobs.

## Measurements and reproduction

Workflow census:15444 sessions,13650 human roots,1794 subagents,0 deep-parsed sessions. Success/correction/retry/intervention rates are UNMEASURED. Minimal curated examples are qualitative, not representative statistics.

Two model canaries failed before threads; token/cost receipts unavailable. One harmless Telegram notification was sent. Scripted-loop zero manual relays is a fixture property, not production evidence. Three specialists later reported usage limits; no credentials were cycled or purchases made.

Future per-job measurements:objective/revision,result,necessary/avoidable interventions,dispatches,latency,provider usage/cost where supplied,notices,recovery failures and uncertain effects. A real observation window must be agreed and elapsed. MemoryMaster's separate14-day shadow gate is not shortened or counted as this pilot's soak.

Run npm test/check/build in the native worktree and Python commands in integrations/hermes-autonomy/README.md. Provider runs require explicit opt-in and passing host canary. CONTROL.md owns continuation; native docs/AUTONOMY-PILOT.md owns stop/health/backup/restore. Retain canary failures as failures.

## Final Linux test timing correction

The final repeated Python run exposed an immediate-after-SIGKILL assertion race. Eight owned-child probes observed R immediately after the timeout and gone10-11ms later. The transport already kills the process group; it reports transport_timeout, not confirmed instantaneous shutdown. Root changed only the test to require gone/zombie within one second and clean up that exact child on failure. GitNexus impact for the test was LOW with no callers. An in-memory inverse mutation disabling os.killpg failed the descendant assertion with stateS; restoring the kill passed. The full WSL suite then passed42 applicable cases/3 platform skips. No production transport behavior or assertion of eventual death was removed. This final test-only change was verified by root after specialist usage limits; it is distinct from the earlier independent review.

## Retained revisions and scope, 2026-09-08 01:32 UTC

Native branch commits: a76120a (core authority/current evidence and regression tests) and fcb66620886931437762cba53212929f1c08b3ca (bounded private pilot, adapter, fixtures, operating guide). Both are local; no push, PR merge or deployment occurred. The original dirty checkout was not changed.

Before initial edits the native project had no resolvable GitNexus index; impact calls returned repository-not-found and direct references/tests were used. A real index was then built for this exact owned worktree. Staged detection reported CRITICAL broad impact:13 core files/19 flows, then58 pilot files/55 flows. Controller, worker and verification callers were inspected; independent review and full regression evidence cover those paths. This is not a low-risk deployment verdict. Final index matches fcb6662 with839 nodes,2843 edges,68 flows,zero embeddings. Generated instruction/skill additions were removed from this owned worktree; existing repository instructions were preserved.
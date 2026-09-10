<!-- doc-head: T-0377 project queue restore evidence, isolated candidate -->
2026-09-08: current-project routing and durable missing-project discard; AC1 and AC2 pass locally.
Read for fail-first evidence, real isolated WezTerm restore proof, and adoption limits.
Shared daemon and MCP were not activated; origin review is pending.
<!-- /doc-head -->

# T-0377 delivery evidence

The queue already resolved a project once per drain. The regression gaps were a stale target retained across messages, a foreign cwd accepted through an old tab label, and missing destinations retained without the required discard event. This does not prove which gap caused the historical incident.

The candidate resolves the original canonical project from a fresh census before each message. A missing project produces durable `queue.entry_dropped` with `reason=project-not-live` and no send. Unknown discovery and ambiguous identity retain pending work. Tombstones use existing suppressed state; failed audit appends retry before ingestion so later sender records cannot lose the discard audit.

## Acceptance evidence

- AC1 pass: `G:/tmp/T0377-before.log` is the actual fail-first run (2 pass, 3 fail): absent destination pending was 1 instead of 0; stale tab label delivered 1 instead of 0; mid-batch restore delivered `[46,46]` instead of `[46,7]`. The basic old-pane reroute control already passed. `G:/tmp/T0377-audit-retry-before.log` records an additional audit-retry failure before its fix. All 10 focused cases pass in the final full suite.
- AC2 pass: `G:/tmp/T0377-live-20260908-accepted/report.json` records actual isolated WezTerm mux restarts and actual PTY delivery: five exact captured messages, zero foreign deliveries. Initial Baja/Wabot IDs 0/1 became Omni; deliveries arrived at Baja 2/2 and Wabot 3. Another restart between two messages changed Baja 2 to 3; both arrived correctly. An absent project was discarded with the required event and no delivery.
- Complete gate: `npm test`, `G:/tmp/T0377-full-final.log`: 1,316 tests, 1,289 pass, 27 skipped, zero failures. Fixture dependency `fc11001` preserves the unreadable-pane test fixture after the required preload.
- Source SHA256 (`src/project-queue.cjs`): `5976a96dac732b623f3a3ab45cf5bb2f39faa1ff42d0a33ca290e29f008cf89c`.
- Live report SHA256: `0c64ef6b2b9c5e9e8c1635500cebc626acd15cc059688d679e3b301a3c6c7585`.

## Reproduce and limits

Run `node --require ./test/setup.cjs --test test/project-queue-current-project.test.cjs` for deterministic regressions. On Windows with WezTerm installed, set `T0377_LIVE_PROBE=1` and run `node scripts/project-queue-restore-probe.cjs <new-output-directory>`. The directory must not exist. The probe uses a dedicated socket, configuration and data-only receivers with a unique ownership token for cleanup. The final report confirms no owned receiver remains.

This tests real mux/PTY transport with data-only receivers, not production agent composer classification. Three owned mux lifetimes were stopped; the shared service was not restarted. Configuration follows official [Unix domains](https://wezterm.org/multiplexing.html#unix-domains) and [daemon options](https://wezterm.org/config/lua/config/daemon_options.html).

GitNexus impact calls could not resolve these CommonJS symbols; unrelated homonyms were not credited. Direct consumers and the complete suite were checked. The isolated index provides file-level scope checking only.

Origin review and adoption remain pending. Preserve the shared checkout's separate pending-expiry changes when integrating. T-0352/T-0354/T-0355 are outside this task. No merge, shared runtime activation or production acceptance is claimed.

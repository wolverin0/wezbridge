<!-- doc-head: T0470 zero-failure suite contract and visible historical boundaries -->
Canonical npm test runs the Node suite with the required WezTerm double and a structured audit reporter.
Unknown active/reactivable kinds fail; terminal historical kinds are named debt. Missing walksim is one explained skip.
<!-- /doc-head -->

# Suite Contract

Run `npm test`. It keeps the Node spec output and adds the structured
`scripts/suite-audit-reporter.cjs` reporter. The reporter requires a nonempty final
aggregate, zero failed tests and zero cancelled tests. A bad/missing aggregate is
RED, never a guessed pass. It uses `test:summary`, not text parsing or a baseline
that permits a fixed number of failures. No new scheduler or service is involved.

The existing routine-report writer records counts in
`_intel/routine-findings/suite-wezbridge-*.json` and its run record. Failed runs
remain visible to routine-audit/fleet-steward even after a later green run;
independent triage resolves the old finding. A green run updates only latest.
An unwritable report is an error, not a silent successful evaluation.
Suite report freshness uses the existing weekly retrospective window (168h), not
the decision relay's five-minute cadence; the relay keeps its existing default.

The historical contract text's `node --test test/*.test.cjs` means this same full
Node test surface. On this project it must use the setup preload, as AGENTS.md
already requires; raw execution without the WezTerm double is not a valid gate.
Use npm test for the audited contract and state total/pass/fail/skip literally.
Individual focused tests are not a substitute for full-suite evidence.

## Historical Data

The current kind vocabulary gates all dispatchable states AND failed, because
failed can return to ready. Done/cancelled cannot reopen in the ledger FSM;
their unknown kinds are returned as `debt.kinds_historicos`, with id/state/kind,
not silently accepted or rewritten. Existing create/update authority gates remain.
Malformed task shape, unknown state and other structural violations still fail.

T-0262 carries `data-fix`, absent from the retained kind vocabulary and history
search. There is no evidence that cancellation removed that kind. Its task was
cancelled by operator on2026-09-06, without the Infra data operation. Keep the
history unchanged; do not register a new permissive kind or reopen the task.

The registry still names the historical walksim pilot but its directory is
absent. Only that named live-path subtest skips, with an inline reason citing
T-0291/T-0470. All other path assertions remain. If walksim returns, the check
automatically runs; the skip does not create a directory or reactivate the pilot.

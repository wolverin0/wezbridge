<!-- doc-head: T-0351 decision relay scheduling, error consumer and 24-hour evidence -->
Windows scheduler uses the queue-drain hidden-wrapper pattern with PT5M repetition.
Read for registration, natural-run evidence, persistent exit-1 reports and the AC3 observation gate.
Registration and a natural delivery do not establish the 24-hour criterion.
<!-- /doc-head -->

# Decision relay scheduling

`scripts/register-decision-relay.ps1 -PlanOnly` prints a reviewable plan;
without that flag it registers `wezbridge-decision-relay`. It refuses existing
tasks or command files. It copies the queue-drain principal and settings, uses
`wscript.exe //B //NoLogo run-hidden.vbs <cmdline>`, and writes one command line:
`node.exe <repo>/scripts/decision-relay.cjs --once --json`.
Repetition is PT5M/P3650D, concurrent instances are ignored, and the execution
limit is four minutes. The installer never starts the task manually.

Every CLI run writes the same JSON it prints into `_intel/routine-findings/`.
Clean runs replace `decision-relay-wezbridge-latest.json` and its `run-` record.
Exit 1 (new flags or fatal error) writes a distinct timestamp/PID artifact and
run record. A later clean run cannot erase it. `routine-audit.loadRuns` reads
these records; fleet-steward, steward-gate and both boards consume that reader.
The existing gate deadline for `routine-void` is 48 hours; the board can show
the failure immediately. Error evidence is retained until reviewed.

The engine currently transfers queued work to queue-drain, so its historical
attempt-cap `flagged` branch is generally bypassed. The regression injects that
engine outcome into the real CLI and verifies its JSON/exit/consumer contract;
it does not claim a natural attempt-cap incident. Fatal errors are also covered.

For AC2, retain the ruling, exported task XML, `Get-ScheduledTaskInfo`, native
TaskScheduler event 100/102, and the decision event. No manual live invocation
of the relay establishes this criterion. On this host, a measured CIM timestamp
reported seconds different from COM and native event time. Preserve both values;
do not rewrite timestamps. The T-0351 second natural probe uses phase :59 so its
ruling/start/event ordering can be checked against both sources.

For AC3, `scripts/observe-decision-relay.cjs --registration <registration.json>`
refuses to measure before `registered_at + 24h`. A one-shot OS task calls it after
that window, with StartWhenAvailable for a missed trigger. It runs the real
steward and gate, saves both outputs, and checks `decision-unheard` only for
non-drill decisions delivered since registration. An empty delivered cohort is
INCOMPLETE. Other findings remain visible and do not become an AC3 failure.
The observation JSON and a criteria result are durably queued to the orchestrator;
the origin still reviews all four criteria before closing T-0351.

Roll back scheduling by disabling these two specifically named tasks:
`wezbridge-decision-relay` and `wezbridge-decision-relay-observation-T0351`.
Keep the command files, rulings, queue state and evidence. Never rewind the relay
cursor to undo a scheduler change: that can replay decisions.

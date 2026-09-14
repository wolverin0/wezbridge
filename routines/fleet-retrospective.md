<!-- doc-head: Weekly fleet retrospective using existing intel, ledger and orchestrator -->
Evaluate outcomes, failures and improvement opportunities; test a bounded correction and compare recurrence.
Registered in _intel/routines/fleet-retrospective.json. No new service, training pipeline or automatic policy promotion.
<!-- /doc-head -->

# Fleet Retrospective

Run every 168 hours through the existing routine audit and orchestrator, or when
the operator asks. A missing weekly receipt becomes a routine finding; the existing
gate and turn cadence determine when it is serviced, not an exact-time guarantee.
First report: _intel/results/2026-09-14-fleet-retrospective.md, T-0469.

1. Plan the window since the previous completed review. Inventory central and
   project-local _intel plus referenced .orchestrator/artifacts and transcripts.
   Mark fixture, backup and worktree copies; never count them as independent runs.
   Census is broad; deep inspection is selected. State coverage and exclusions.
2. Evaluate successes, rejected/partial results, repeated errors, retry loops,
   operator interventions, missing logs and cost/model evidence when present.
   Join source/project/session/task/corr/message identity. Submission is not ACK;
   ACK is not acceptance. Do not reward more messages, rulings or files written.
3. Read the evidence behind selected outcomes. Preserve unknowns. Distinguish
   exact transport duplication from repeated legitimate nudges for unresolved work.
   Sample both good and bad paths; compare with previous lessons and regressions.
4. Select at most two bounded corrections. Reuse existing cards for known work;
   create a linked card only for genuinely new work. Dispatch beyond own scope.
   Require fail-first or a measured inverse control, proportional tests and an
   explicit rollback. Never change production, credentials or approvals as a lesson.
5. Write _intel/results/<date>-fleet-retrospective.md: window, source inventory,
   facts vs hypotheses, retained good behavior, selected improvements, test output,
   remaining failures, owner/task links and next comparison. Do not claim model
   training or all-history semantic coverage from a sample. Never export secrets.
6. After the review actually runs, write its normal existing routine receipt:
   _intel/routine-findings/fleet-retrospective-<date>.json with verdict
   findings (survived items with title and task links), clean (no findings), or void
   (execution failed). Matching run-fleet-retrospective-<date>.json identifies
   routine=fleet-retrospective, repo=wezbridge, cadence_hours=168, exit_status and
   findings_file. Do not mark clean merely because the review finished.
7. At the next cycle, measure whether each change reduced its specific failure.
   Keep, revise or revert on evidence; successful tests are not proof of live impact.

Use existing Workflow Intelligence reports when useful; do not build another
database/dashboard/watcher. Never write approvals or human review labels on the
operator's behalf. This routine is the user's periodic review-and-improve loop.

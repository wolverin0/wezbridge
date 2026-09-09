<!-- doc-head: T-0406 five bot briefs to SP Avisos; SHA idempotency and pending 24-hour acceptance -->
syncBriefs reads the five canonical latest files, creates one task per content SHA and completes the previous task of that bot.
State and exclusive lock sit beside .sp-bridge/map.json; ambiguous writes fail closed and can recover via exact SP markers.
Read for CLI integration, local-link limitations, restart/install requirements and the origin-owned 24-hour measurement.
<!-- /doc-head -->

# Briefs To Avisos

`node scripts/sp-bridge.cjs sync-briefs` synchronizes only briefs. The existing
`sync` command now includes this phase after decisions, intake and outcomes.
Its last-success record includes the briefs result; a missing or invalid brief
leaves last-success unchanged and records stage `briefs` in failure evidence.

The roster is fixed: centinela, dep-scout, wabot-curador, auditor-ronda and
skill-curator. Inputs are `_intel/briefs/<bot>-mas-reciente.md`. SHA-256 is over
the exact file bytes, not a timestamp or normalized text. Empty or over-256-KiB
files are rejected rather than silently truncated.

Each task is in `Avisos`, tagged `agente`, and contains its source file link,
SHA, complete brief text and exact `[ext:brief:<bot>:<sha>]` marker. The file URL
is a local desktop link, NOT a public/mobile HTTP link. The copied note makes
the brief readable inside synchronized SP data, but this change does not prove
phone rendering or that a phone can open the local source file. No arbitrary
file server or public share is introduced.

## Idempotency And Ownership

- `.sp-bridge/briefs.json` stores active task/SHA per bot, known revisions and a pending intent. It never rewrites the existing map.json.
- `.sp-bridge/briefs.lock` excludes concurrent brief syncs. A crashed process can leave a lock; inspect its PID and state before an operator removes it. No automatic stale-lock deletion.
- The intent is durably recorded before addTask. If its reply is lost, the next run searches SP for the exact marker. It does not resend an ambiguous add without a matching task.
- The new task ID is saved before completing the predecessor. Completion failures remain retryable without creating a second new task.
- Project, task ID and SHA marker must agree before completing a predecessor. Corrupted state cannot redirect completion to an operator task.
- Repeated known content never creates another task. Manually completed tasks are not reopened merely because the same bytes are observed again.
- Missing/corrupt state and duplicate matching SP tasks are not silently accepted. State loss can recover existing exact markers; ambiguous outcomes remain visible for reconciliation.

## Verification

The AC1 test failed before implementation because syncBriefs was absent. With
the implementation, a repeated SHA creates zero new tasks; changing one file
creates one task and completes exactly that bot's predecessor. A second
fail-first guard caught a corrupted predecessor ID before the ownership check
was added. Focused tests additionally exercise lost responses, partial completion,
concurrency, missing files, corrupted state and full-sync failure timestamps.

The live trial uses the real five source files and SP file protocol. Evidence
is recorded in the T-0406 result, including selected getTasks output, IDs, SHA
values and the second run's zero-creation result. No brief was altered to make
the live proof pass.

## Activation And Acceptance

The shared checkout, its daemon, and the existing schtask remain untouched.
After independent review/merge, install `scripts/sp-bridge.cjs` and
`scripts/sp-briefs.cjs` together in the checkout called by
`wezbridge-sp-bridge-sync`. It runs every five minutes and loads these one-shot
scripts on each execution: no daemon/MCP restart is needed. A merge by itself
does not update that runtime checkout.

AC4 belongs to the orchestrator: verify each new brief arrives within ten
minutes throughout 24 hours after activation. A successful manual trial does
not establish this scheduled-run criterion; leave the task in review.

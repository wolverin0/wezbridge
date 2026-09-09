<!-- doc-head: T-0417 registered lease owners reconcile against live cwd; parity guarded -->
Read when changing lease.owner parsing, ledger validation or interpreting reconciliation counts.
Canonical forms: pane-N, executor:id, registered project slug. Recognition alone never proves liveness.
CLI is read-only; missing census/registry and unsupported executors remain explicitly unverified.
<!-- /doc-head -->

# Lease Owner Reconciliation

The ledger accepts registered project slugs and generic executor ids. The previous
reader accepted only Eve and pane ids, so legitimate slug leases were incorrectly
reported as illegible instead of checking their live cwd.

`parseOwner` now shares the canonical regex forms with the ledger and recognizes
only slugs present in `repos.json`. A slug is resolved through its registered path
and the existing `repoMatchesCwd` rules. No matching live cwd produces a finding
containing `sin pane vivo`; a partial census with blank cwd remains unverifiable.
Generic executors are recognized but not presumed alive or passed to Eve's verifier.
Historical decorated owners such as `pane-94 (wezbridge)` remain readable, while
the ledger correctly rejects writing that legacy syntax.

`reconcileLeases` retains its findings-array API consumed by fleet-steward.
The CLI additionally reports open, verified and unverified counts, per-lease reasons,
the measured census and task-read errors. It uses the existing canonical mux invocation,
not a bare WezTerm call with an inherited alternate socket. Exit 1 means a finding
or an incomplete measurement, not necessarily a process failure. It never changes leases.

```powershell
$env:WEZBRIDGE_INTEL_DIR = '<Fleet root>/_intel'
node scripts/lease-reconcile.cjs
```

## Evidence

Artifacts: `G:/tmp/T0417-20260909/`.

- `baseline-proof.json` seals unmodified source at main `19f0f1c` before the fix.
- `fail-first.log`: AC1 and AC2 both failed before editing production code (0 pass, 2 fail).
- `inverse-ac2.log`: changing slug liveness to unconditional success yields zero findings
  without a live pane and fails the guard assertion (expected one finding).
- `parity.log`: both tests against the real exported `assertLeaseOwner` passed.
  Regex parity, a boundary/invalid-input corpus and normalized function fingerprints
  make a fourth branch in either parser require explicit parity review. Fingerprints
  intentionally also require review after otherwise benign edits to these functions.
- `focused-coverage.log`: 27 focused tests passed; reconciliation line/branch coverage
  98.19%/86.14%, CLI coverage 100%/95% (unrelated WezTerm functions are not the coverage scope).
- `full-final.log`: full `npm test`, 1,335 total, 1,308 passed, 27 skipped, zero failed.
  `WEZBRIDGE_LEASE_LEDGER_PATH` pointed at the real companion ledger for this run;
  parity tests use an isolated registry and do not modify real cards.
- `live-reconciliation.json`: 400 task files read without errors, 11 live panes,
  one open lease, one verified, zero unverified: T-0417, owner `wezbridge`, live pane 94 cwd.

The task's historical T-0339/pane-8 example is no longer live: T-0339 has `lease: null`.
It is correctly excluded, not falsely claimed reconciled and not given a fabricated lease.
The actual open slug lease supplies the current runtime proof.

To run just the parity integration gate from an isolated worktree:

```powershell
$env:WEZBRIDGE_LEASE_LEDGER_PATH = '<Fleet root>/_docs-curation/ledger.cjs'
node --require ./test/setup.cjs --test test/lease-owner-parity.test.cjs
```

Without the companion, the parity test declares a skip rather than pretending to check
the writer. GitNexus did not resolve the CJS symbols; direct references identify
fleet-steward as the production caller. The complete suite exercises that consumer.
No graph-control components, scheduler registration, remote executor service or daemon
are activated by this change. Existing long-lived consumers need their normal reload
to pick up changed source; the measured CLI invocation uses a fresh process.

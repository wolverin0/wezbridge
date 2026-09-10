<!-- doc-head: September consolidation scope and verification boundaries -->
Integrates current main, validated inbox/ruling fixes, recovery ownership and pending reviewed delivery fixes.
Preserves legacy branches and private workstation artifacts without publishing or activating them.
Read before treating source publication as runtime adoption or completion of the paused graph/autonomy pilots.
<!-- /doc-head -->

# September Consolidation

The operator explicitly authorized merging and pushing pending Wezbridge work on September 10.
Integration uses an isolated branch and preserves the shared checkout before reconciliation.

## Included

- T-0355 inbox starvation diagnostics and refusal attempt/cooldown preservation.
- T-0435 validated and persisted `value_landed_in` metadata.
- Existing main changes for current-project queue identity, SP briefs/heartbeat, lease-owner slugs and pinned sends.
- Pending canonical socket routing and operator-question guards (PRs 24 and 23).
- Exact selected-agent recovery, Codex discovery and prevention of duplicate snapshot restoration.
- Pending-entry expiry, dead-letter exclusion and retryable result lease release.
- Independently reviewed outcome-based wake decisions from the autonomy branch.
- Cross-feature regressions proving operator questions are neither suppressed as noise nor mistaken for review receipts.
- Reviewed T31 drill document (PR 16), maintained instruction adapters and dated research.
- Existing optional workstation maintenance scripts; publication does not install or execute them.

## Verification

The fresh-clone affinity test now creates a real temporary configuration file instead of requiring private sibling state.
The fleet transport drill explicitly disables debounce, preserving its send-integrity assertions and separate debounce tests.
The integrated waker adds two fail-first tests: both failed before the compatibility fix; 54 combined tests passed after it.
Result retry and fleet drill tests passed 19/19 with canonical companion dependencies supplied.
The final source-only full suite collected 1429 tests: 1398 passed, zero failed, 31 declared external-dependency skips.
Canonical companion checks separately passed 19/19; the shared live-registry gate is reported separately, never disguised as a source-only pass.
The publication revision and canonical-checkout counts are recorded in the operator's consolidation result.
PowerShell maintenance scripts were parsed without executing them; no watchdog was installed or activated.

## Preserved Separately

Machine reports, screenshots, local recovery backups, personal media, old handoffs and unrelated skill drafts are not public product source.
Their exact path/hash inventory and original copies are retained in the operator's local release snapshot.
Historical experiment branches are not equivalent to pending production changes; no branch is deleted by this consolidation.
The locked graph-control candidate and unfinished native pilot remain separate. Their source publication or operational cutover requires their own acceptance gates.
The old stable-mux proposal is superseded by current canonical transport routing; its branch remains available as historical evidence.

## Runtime Boundary

No daemon restart, live queue replay, graph activation, credential change or external deployment is part of this source consolidation.
Already-running MCP and daemon processes retain loaded code until their owning process is deliberately refreshed.
Scheduled one-shot commands may load updated checkout files on their next normal run; that is not evidence that their external journeys succeeded.

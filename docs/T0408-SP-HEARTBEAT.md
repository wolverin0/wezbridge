<!-- doc-head: T-0408 SP heartbeat detector; isolated verification, runtime activation pending -->
Detects last-success.json older than 15 minutes via the existing five-minute DaemonSentinel task.
Writes sp-bridge.stale and sends a signed P1 through the existing personaldashboard gateway.
Read for episode deduplication, failure evidence, simulation results and activation boundaries.
<!-- /doc-head -->

# SP Heartbeat

`scripts/daemon-heartbeat-sentinel.cjs` calls `scripts/sp-bridge-heartbeat.cjs`
before its daemon probe. It does not depend on the SP plugin or the daemon.
The existing `WezBridge-DaemonSentinel` schtask repeats every five minutes;
after deployment, an age greater than 15 minutes is detected on the next tick.
Exactly 15 minutes is still fresh. Missing, malformed or future timestamps are
unverifiable and raise the same alert with an explicit reason.

The checker reads `WEZBRIDGE_INTEL_DIR/.sp-bridge/last-success.json` (default:
the repository parent's `_intel`). It appends one `sp-bridge.stale` event per
episode to `events.jsonl`, retaining the observed timestamp and age. State lives
beside the existing map in `.sp-bridge/heartbeat-state.json`. A fresh success
resets the local episode; it does not acknowledge an existing inbox alert.

The P1 path is the existing `events-gateway.cjs` sender, source `wezbridge`,
kind `decision`, without signed task actions. The hub maps that pair to P1;
caller severity alone cannot select routing. Configuration comes from
`wezbridge/.env.local`, overridden by environment. No Telegram fallback is
invented when the gateway is unconfigured. Requests time out after eight seconds.
Unconfigured/failed delivery is recorded and retried on the next tick with the
same episode key. HTTP acceptance is explicitly not feed verification.

## Verification

The killer in `test/sp-bridge-heartbeat.test.cjs` launches the actual sentinel
entrypoint with an old SP file and a healthy daemon fixture. Before the change
it failed because no event was written. It now checks the real event file.
Additional tests cover the boundary, missing/invalid timestamps, episode reset,
dedupe, failed delivery retries and the signed P1 HTTP request without actions.

On 2026-09-09 a separate synthetic `_intel` with a 16-minute-old file wrote
`sp-bridge.stale`. The live gateway accepted it with HTTP 201, and authenticated
`GET /v1/feed` returned that exact entity as P1 with alert ID
`4c931c75-2282-4b01-9a3b-cfe5a222b03d`. Its title explicitly says SIMULACION T-0408.
The live SP plugin and its real last-success file were not changed.

## Activation

This work does not replace files in the shared runtime checkout or restart any
daemon. After review/merge, the runtime owner must install the two script files
together into the checkout used by `WezBridge-DaemonSentinel`, then verify a
scheduled execution. This one-shot script needs no daemon/MCP restart: the next
schtask run loads it. Merely merging the PR does not activate the detector.

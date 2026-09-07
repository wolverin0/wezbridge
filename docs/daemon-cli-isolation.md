<!-- doc-head: T-0379 daemon CLI isolation, call inventory and sentinel observation freshness -->
Daemon HTTP/timer code uses daemon-cli child operations with a 25s deadline; sync CLI is refused in the owner process.
Covers waker, recovery, pane handlers, census fallback, snapshot and retained descendants; no new polling daemon.
Read before adding a CLI caller to dashboard-server or diagnosing a stale-heartbeat restart alert.
Tests use the real daemon on a temporary port and a synthetic CLI, never the live mux.
<!-- /doc-head -->

# Transport contract

The daemon entry records its own PID in `WEZBRIDGE_DAEMON_OWNER_PID`. The synchronous WezTerm wrapper refuses CLI execution when that value equals the current PID. Forked workers inherit the marker but have a different PID. MCP and streamer processes retain their existing transport API.

`src/daemon-cli.cjs` is an asynchronous facade over the existing WezTerm and verified-send primitives. Each operation runs in `daemon-cli-worker.cjs`, with a default 25-second parent deadline, a maximum 30-second configurable test/constructor deadline, and at most four simultaneous operations. Saturation rejects explicitly. The broker does not retry a potentially delivered mutation. A timeout is an unknown delivery, not proof that no effect occurred.

The parent deadline does not wait for child exit or pipe EOF. It cancels only the owned process tree, asynchronously (`taskkill /T /F` on Windows, a detached process group on POSIX). Native CLI errors also trigger tree cleanup. Successful pane creation may deliberately leave a GUI alive; other completed operations leave no persistent worker or CLI descendant. The existing census worker uses the same asynchronous tree-kill helper. No new periodic watcher was introduced.

# Inventory of daemon call sites

| Path | Previous synchronous work | Current boundary |
|---|---|---|
| `handlers/event-handlers.cjs`, orchestrator waker | `verified-send` composer reads, bracketed paste, Enter and readback | Injected `daemon-cli.verified` operations; waker awaits them |
| `orchestrator-waker.cjs`, source held-composer rider | Parses text already present in the census | Remains pure; no CLI operation here |
| `clawtrol-bridge.cjs` / event handler notifier | Fallback discovery and operator-message sends | Awaited cached/worker discovery and child transport; retirement decision unchanged |
| `pane0-watchdog.cjs` | Fallback discovery and recovery spawn/send | Injected async discovery and transport; await retained in recovery |
| `a2a-heartbeat.cjs` | None: iterates in-memory A2A state and emits SSE | No change; no CLI call to move |
| `dashboard-server-ipc.cjs` | Discovery fallback, spawn, send and title | Async collection/transport; consumers await results |
| `handlers/pane-handlers.cjs` | Output, prompt, key, broadcast, kill and handoff polling/sends | Every transport operation awaited through the facade |
| `handlers/agent-handlers.cjs` | Spawn and bootstrap sends; collection | Same async boundary |
| `handlers/event-handlers.cjs`, HTTP/SSE/monitor paths | Handoff send, event output, discovery, monitor collection | Async facade; event translation remains ordered and monitor ticks do not overlap |
| Snapshot when census disabled/unavailable | Raw list/discovery and capture from the parent | Existing snapshot timer invokes a bounded child operation; snapshot ticks do not overlap |
| Census worker supervision | Synchronous taskkill could block the parent during recovery | Async owned-tree kill; census itself remains in its existing child |

Synchronous Git operations in existing worktree-management routes are not WezTerm calls and were not changed by this task. Filesystem readers and pure parsers were also retained.

# Sentinel observation order

The sentinel may read the initial heartbeat for forensic context. Its verdict uses a fresh read after the HTTP probe, then another after discovering the target pane and immediately before preparing the alert. Recovery during either wait suppresses an obsolete restart recommendation and records `recovered-before-alert`. A heartbeat that is still stale continues to alert; failed HTTP with a fresh heartbeat retains the existing sustained-failure policy.

# Reproduction and limits

`test/daemon-census-worker.test.cjs` reuses the T-0321 real-daemon harness. Four hung, uncached output reads previously starved the heartbeat beyond 60 seconds even with census in a worker. The new case samples heartbeat and HTTP for 65 seconds, checks a responsive CLI control, and requires hung reads to reach the worker timeout rather than merely fail the sync guard.

The native-timeout hypothesis is a separate measurement: on the tested Windows Node 22.14 host, a confirmed pipe-holding descendant did not defeat the ten-second `execFileSync` timeout. That does not establish a 42-minute single-call hang; evidence must distinguish that unconfirmed hypothesis from the reproduced accumulation of synchronous waits.

Code on disk and an isolated passing daemon do not prove a resident daemon has loaded the fix. Runtime activation and live-mux behavior require their own owning-component verification.

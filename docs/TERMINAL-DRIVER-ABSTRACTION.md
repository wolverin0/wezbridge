# ADR: WezBridge Terminal-Driver abstraction (Windows Terminal / Intelligent Terminal backend)

Status: **Design-only / deferred** — blocked on a Windows 11 target. No code changes made.
Date: 2026-06-04
Owner: wezbridge
Supersedes: nothing. Related but distinct from `docs/ADAPTER-STRATEGY.md` (that doc is about
ForgeFlow *tool* adapters; this is about WezBridge's *terminal backend*).

> **TL;DR.** Microsoft's `microsoft/intelligent-terminal` ships `wtcli`, a Windows Terminal
> Protocol control API that covers WezBridge's entire pane-control primitive set. That makes
> Windows Terminal a candidate *second backend* for WezBridge. The clean way to add it is a
> `TerminalDriver` interface with the current WezTerm code behind a `WezTermDriver` and a new
> `WtDriver` for `wtcli`. **But it cannot be built/tested on WOLVERIN0 today** (Windows 10;
> Intelligent Terminal needs Win11 22H2). Per "no abstractions before a real second consumer,"
> we record the design now and execute it *spike-first* when a Win11 target exists.

---

## 1. Strategic summary + blocker

### What Intelligent Terminal / `wtcli` offers
`microsoft/intelligent-terminal` (v0.1.0, published 2026-05-29) is an experimental fork of
Windows Terminal installed side-by-side with the normal one. It adds a docked ACP agent pane,
shell-integration error detection (OSC 133 exit-code markers), background delegate tasks, an
agent session manager — and, the part that matters for us, **`wtcli`**: a CLI client for the
Windows Terminal Protocol that agents can shell out to. Documented commands:

```
wtcli --json list-windows | list-tabs | list-panes | active-pane
wtcli --json capture-pane [--last-prompt] | pane-status
wtcli --json new-tab | split-pane
wtcli kill-pane | focus-pane
wtcli --json send-keys --raw "<text>" | send-keys Enter
wtcli --json listen | send-event | publish | info
```

`send-keys` is real: it calls COM `IProtocolServer::SendInput(sessionId, text)`. So `wtcli`
covers the WezBridge primitive set (capture/send/list/spawn/split/kill/status), **plus**
Windows-native extras WezTerm doesn't have: shell-integration failed-command events,
active-pane context, agent-pane session tracking, ACP-native orchestration, all on a
Microsoft-maintained protocol.

### The blocker (verified 2026-06-04)
- Intelligent Terminal requires **Windows 11 22H2, build 22621.6060+**.
- WOLVERIN0 reports **Windows 10 Pro, build 19045** (`Get-CimInstance Win32_OperatingSystem`).
  `19045 < 22000` → **not Windows 11** → Intelligent Terminal **will not install**; `wtcli`
  is absent; the `WT_COM_CLSID` COM server does not exist here.
- Hardware is *over*-capable for Win11 (Intel Core i9-14900K, 63.8 GB RAM). TPM/Secure-Boot
  probes failed on access/BIOS-mode (likely PTT/Secure Boot toggled off + Legacy/CSM boot),
  not on absence. So an upgrade is feasible — but the user has chosen to **stay on Windows 10**.

### Why design-only
The *only* thing motivating a `TerminalDriver` abstraction right now is the WT backend, and it
cannot run on this machine. Building the abstraction now would be speculative (violates the
"no abstractions before a real second consumer" rule). So: record the design; build nothing;
re-activate when a Win11 target (VM, in-place upgrade, or other machine) exists.

---

## 2. Current architecture — the abstraction surface (with code citations)

WezBridge is already **one file away** from a driver pattern.

- **All** WezTerm coupling lives in `src/wezterm.cjs` (~496 lines). It owns: WezTerm path
  resolution (lines ~13-42), Windows GUI-socket discovery via `tasklist` (lines ~53-120), the
  `wezCmd()` exec wrapper (lines ~124-146), three TTL caches (listPanes 3000 ms, getText
  1500 ms, gui-socket 30000 ms), and every `wezterm cli` subcommand call.
- Consumers already treat the terminal layer as an **injectable dependency**:
  - `src/mcp-server.cjs` imports `wez` and 14 of ~15 tools call `wez.*` directly; only
    `auto_handoff` routes through the dashboard HTTP API (`/api/panes/:id/auto-handoff`).
  - `src/goal-dispatch.cjs` takes `wez` as `deps.wez || require('./wezterm.cjs')`.
  - `src/dashboard-server.cjs` is a parallel consumer of the same `wezterm.cjs`, not a broker
    the MCP server depends on.
  - `src/pane-discovery.cjs` calls only `wez.listPanes()` + `wez.getFullText()`; its
    Claude-detection / status / persona / Ctx% parsing is **regex over scrollback** — already
    backend-agnostic (works on any terminal's text).

### The `TerminalDriver` primitive set (from `wezterm.cjs` exports)
Core (every backend must implement):
`listPanes`, `getFullText` / `getText`, `sendText`, `sendTextNoEnter`, `spawnPane`,
`killPane`, `setTabTitle`, `activatePane`, `splitHorizontal`, `splitVertical`.

Optional (capability-gated; some backends lack these):
`listWorkspaces`, `switchWorkspace`, `spawnInWorkspace`, `spawnSshDomain`.

Infra (may be no-ops on some backends):
`invalidateListPanesCache`, `invalidateGetTextCache`, `ensureGui`.

Pane object shape returned by `listPanes()` today:
`{ pane_id:int, tab_id:int, window_id:int, title:str, tab_title:str, cwd:str, workspace:str, is_active:bool }`.

---

## 3. Target design — TerminalDriver + dual-field IDs

### Module layout
```
src/terminal-driver.cjs        # interface / contract (jsdoc or plain object shape)
src/drivers/wezterm-driver.cjs # current src/wezterm.cjs moved behind the interface
src/drivers/wt-driver.cjs      # NEW, wtcli-backed (DEFERRED until the spike passes)
```
Selection via `backend=wezterm|wt|auto` (env or config). `discover_sessions` merges
`WezTermDriver.listPanes()` + `WtDriver.listPanes()` into one normalized list.

### `wtcli` → primitive mapping (for the future WtDriver)
| WezBridge primitive | `wtcli` command |
| --- | --- |
| `getText` / `getFullText` | `wtcli --json capture-pane -t <guid> [-l <lines>]` (`--last-prompt` for prompt-only) |
| `sendText` | `wtcli --json send-keys -t <guid> --raw "<text>"` then `send-keys Enter` |
| `sendTextNoEnter` | `wtcli --json send-keys -t <guid> --raw "<text>"` |
| `sendKey` | `send-keys Enter` / `C-c` / `Tab` / `Escape` / `BSpace` |
| `listPanes` | `wtcli --json list-windows` / `list-tabs` / `list-panes` |
| `spawnPane` | `wtcli --json new-tab -c "<prog>" -n "<title>"` |
| `splitHorizontal` / `splitVertical` | `wtcli --json split-pane -t <guid> -d right|down -c "<prog>"` |
| `killPane` | `wtcli kill-pane -t <guid>` |
| `activatePane` | `wtcli focus-pane -t <guid>` |
| `paneStatus` | `wtcli --json pane-status -t <guid>` |
| (no equivalent) | `listWorkspaces` / `switchWorkspace` / `spawnSshDomain` → capability=false |

Key mapping: `enter→Enter`, `ctrl+c→C-c`, `tab→Tab`, `escape→Escape`, `backspace→BSpace`.

### ID strategy: dual-field, NOT namespacing
**Keep `pane_id` as an integer.** Add `backend` (`"wez"` | `"wt"`) and a computed
`backend_qualified_id` (`"wez:8"` / `"wt:<guid>"`) for display/routing only.

Why not rename IDs to strings like `wez:8` (the "namespacing" approach):
- It ripples to **~47 sites** across API schemas, route parsing, and tests.
- It breaks the **A2A text protocol**: the `pane-(\d+)` regex appears in
  `src/dashboard-server.cjs` (`A2A_ENVELOPE_RE`), `src/telegram-streamer.cjs`, and
  `src/sidecar-watcher.cjs`. A2A envelopes are *user-visible text copied between panes*, so a
  format change breaks at runtime.
- It breaks **3 persisted JSONL files** that store integer `pane_id`:
  `teams.jsonl`, `session-snapshot.jsonl`, `cost-meter.jsonl` (would need schema versioning +
  a migration/back-compat reader).

Dual-field is near-zero-breakage: existing integer keys, maps, route parsing, and serialization
all keep working; the WtDriver just reports unique integer ids in a reserved range (or a stable
guid→int map) and carries the real guid in `backend_qualified_id`.

**Preserve the pane-0 sentinel rule.** `src/goal-dispatch.cjs` already admits `pane_id === 0`
via explicit `=== undefined/null/''` checks (not truthiness). Any ID work must keep pane 0 valid
(it is the Claude sentinel address).

### Unchanged surfaces
- MCP tool **names and schemas stay identical** — agents (Claude/Codex/Hermes) don't care which
  backend answers.
- Telegram streamer polls per-backend: `wez:<id>` → `wezterm cli get-text`;
  `wt:<guid>` → `wtcli capture-pane`. Same topic model.

---

## 4. The make-or-break: the remote-control path

`wtcli` talks to a **per-user-session COM server** (`WT_COM_CLSID`). WezBridge's whole value
proposition is that **Hermes/Otacon can reach panes over SSH into WOLVERIN0**. A `wtcli` that
only works from a shell *launched inside Intelligent Terminal* would not satisfy that. This is
the spike's pass/fail gate. Three options to validate, in order of preference:

- **(C) Direct from SSH.** Try `wtcli --json info` / `list-panes` from a plain SSH session. If
  COM is reachable across the session boundary → simplest; WtDriver is "just shell out to wtcli."
- **(A) Bridge daemon inside Intelligent Terminal.** A shell tab inside IT runs a small
  `node src/wtbridge-daemon.cjs` that inherits the right `WT_COM_CLSID`, calls `wtcli`, and
  exposes a local HTTP/MCP port Hermes reaches over SSH.
- **(B) User-session daemon.** A scheduled task / startup process under `pauol` that holds the
  IT COM access and serves the bridge.

If only (A)/(B) work, the WtDriver is meaningfully larger than a thin CLI shim (it needs the
daemon + transport), and that cost must be weighed before committing.

---

## 5. Deferred spike checklist (activates with a Win11 target)

1. Stand up a Win11 22H2 target (Hyper-V VM on WOLVERIN0 is cheapest/non-disruptive; in-place
   upgrade or another machine also work).
2. `winget install --id Microsoft.IntelligentTerminal -e` (or Microsoft Store).
3. Open PowerShell inside it; verify locally:
   `wtcli --json info` · `list-windows` · `list-tabs` · `list-panes` ·
   `capture-pane --last-prompt` · `send-keys --raw "echo hello"` · `send-keys Enter`.
4. **Remote-control gate:** run §4 options (C → A → B). Record which works. STOP and report if
   none do — that kills or reshapes the WtDriver plan.
5. If the gate passes:
   - **Phase 1 (low-risk, ~1 wk):** extract `src/terminal-driver.cjs`; move `src/wezterm.cjs`
     to `src/drivers/wezterm-driver.cjs`; inject the driver; add the `backend` dual-field. No
     behavior change on WezTerm; all 184 existing tests stay green.
   - **Phase 2:** decouple the TTL caches to a generic `CachedDriver` decorator (keyed by pane
     id, not by WezTerm JSON shape); stub `ensureGui()` per backend.
   - **Phase 3:** implement `src/drivers/wt-driver.cjs` per the §3 mapping table; add
     capability flags (`{workspaces:false, sshDomains:false}`); wire `backend=auto` discovery
     merge.
6. Keep the MCP schema stable throughout. Add tests mirroring `test/pane-identity.test.cjs`
   and `test/goal-dispatch.test.cjs` with a stub WtDriver.

---

## 6. Out of scope now

- No OS install/upgrade. No `src/` changes. No A2A-protocol or persisted-ID-format change.
- The current WezTerm-coupled code stays exactly as-is; it is healthy and proven.
- Everything above is gated on the §5 spike passing on a real Win11 target.

---

## Appendix — why WezTerm still wins today
WezTerm/WezBridge is mature, already working, CLI-agnostic, cross-platform, reachable from
Hermes via socket discovery, with stable `wezterm cli get-text/send-text/list` and a working
Telegram streamer. Intelligent Terminal is v0.1 experimental (documented COM/WinRT crash cases,
session-tracking rough edges, delegate model-selection not exposed, autofix can drop events
pre-connect). The prize is a **unified TerminalBridge** — WezTerm for proven mux control,
Intelligent Terminal for native Windows agent/error/session features — but only after the spike
proves the remote-control path on real Win11.

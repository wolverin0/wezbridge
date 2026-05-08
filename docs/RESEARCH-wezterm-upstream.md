# Research — Upstream WezTerm: what we missed, what's broken in main, what to act on

**Date:** 2026-05-08
**Status:** Research output, no code changes. Decisions deferred to user.

## TL;DR

| Finding | Severity | Action |
|---|---|---|
| Last WezTerm release was **2024-02-03**. HEAD is **804 commits ahead.** | High | Build from source or run nightly to get 15 months of fixes. |
| Issue #7527 (OPEN, 2026-01-25): "Unbounded PDU memory allocation causes OOM crashes and stack overflow" — Windows, mux server, codec layer. **Matches our 10054 mux-disconnect symptom exactly.** | Critical | Add our repro + comment on the issue. The `WEZTERM_LOG=...local=off` env var we use is hiding this, not fixing it. |
| Issue #3237 (OPEN since 2023-03): "Provide a way to save the current layout" — exact feature request our v3.4.0 implements. | Medium | Consider contributing v3.4.0's design (cmdline capture) upstream as a starter PR. |
| Issue #5882 (OPEN): Windows wezterm hangs randomly, often on pane close. | Medium | Watch — could be related to our crash patterns under MCP load. |
| `pane:get_foreground_process_info()` returns full **`argv` array** natively, cross-platform. | High | Replace our PowerShell wmic call in `session-snapshot.cjs` with this when v3.4.x moves to a Lua plugin layer. |
| `wezterm.on('mux-startup', ...)` fires on fresh mux boot — the missing crash-detection signal. | High | Single hook gives us auto-prompt-to-restore after any wezterm crash. No CLI script needed. |
| Plugin `resurrect.wezterm` exists, captures windows/tabs/panes/cwd/scrollback/SSH-domain — but **only `process` (binary path), NOT full cmdline**. | Medium | Don't deprecate v3.4.0 (cmdline is our value-add) but combine: their workspace+text capture, our cmdline. |
| `wezterm cli record` + `replay` exist but are unrelated to our pain (terminal recording, not session save). | Low | Skip. |

## Phase 1 — Upstream issues matching our pain points

### #7527 — Unbounded PDU memory allocation causes OOM crashes and stack overflow

- **State:** OPEN, "needs:triage", reported 2026-01-25 against nightly `20260117-154428`
- **Platform:** Windows 11, build from source
- **Symptoms (verbatim):**
  - `ERROR  wezterm_mux_server_impl::local > encoding PDU to client: Allocation error : not enough memory`
  - `thread 'main' (PID) has overflowed its stack`
- **Affected:** mux server, GUI, codec layer (`codec/src/lib.rs`)
- **Root cause (per reporter):** PDU decoder allocates memory based on network-provided size values without validation, allowing arbitrary-sized allocations that exhaust memory.
- **Why it's our bug:** the `WEZTERM_LOG=wezterm_mux_server_impl::local=off` env var documented in this repo silences exactly the error category this issue surfaces — under sustained MCP load (lots of `wezterm cli` calls hitting the mux), the PDU decoder accumulates oversized allocations until memory exhausts and the mux dies. We've been muting the symptom for ~2 months.
- **Action recommendations:**
  1. Add a comment to #7527 with our repro context: sustained MCP load via `wezterm cli list / get-text / spawn / send-text` from a Node daemon at 60s intervals across N panes for hours; observed mux disconnect on Windows 10/11.
  2. Consider whether running a custom-built wezterm with PDU size validation is worth the effort. The fix is conceptually simple (cap PDU size before allocating); we could prototype a patch and submit it.

### #5882 — [windows] wezterm hangs randomly, mostly but not exclusively, when closing panes

- **State:** OPEN bug, no clear repro
- **Platform:** Windows
- **Reporter:** does not have a deterministic repro; suspects interaction with git-credential-manager
- **Why it's tangentially relevant:** our Telegram channel-plugin race symptoms include unexpected pane closures; this could be a contributing factor on the wezterm side.
- **Action:** monitor; not a primary action item.

### #3237 — Provide a way to save the current layout

- **State:** OPEN since 2023-03-13
- **Reporter wants:** save layout (windows/tabs/panes/titles/cwd), optionally scrollback. tmux-resurrect equivalent.
- **Why it matters to us:** this is **exactly** what wezbridge v3.4.0 implements (plus our cmdline-capture innovation). The community plugin `resurrect.wezterm` is the de-facto solution today.
- **Action:** if we want this baked into wezterm itself (vs forever-plugin), our v3.4.0 design plus the resurrect.wezterm patterns are a reasonable starting point for a PR. Not urgent.

## Phase 2 — WezTerm features we're under-using

### Native process info (replaces our PowerShell wmic call)

```lua
local info = pane:get_foreground_process_info()
-- info.argv is the full command-line args array
-- info.executable is the absolute path
-- info.cwd is captured natively
-- info.children is the entire process tree
```

- Cross-platform (Linux, macOS, Windows). No PowerShell subprocess.
- Local panes only (not SSH/mux remote panes — same constraint we have).
- One single Lua call replaces:
  - `Get-CimInstance Win32_Process` invocation
  - `ps -p N -o args=` invocation
  - The classifyAI heuristic over title (we still need that, but with cleaner inputs)

`wezterm.procinfo.get_info_for_pid(pid)` is the standalone version when you have just a PID.

### Mux startup event (auto crash recovery hook)

```lua
wezterm.on('mux-startup', function()
  -- fires when wezterm-mux-server starts fresh
  -- ie after every cold boot, every wezterm crash
  -- we can read our snapshot here and prompt user to restore
end)
```

- This is the missing signal. After a wezterm crash, the user reopens wezterm, mux starts fresh, this fires. We can read `vault/_wezbridge/session-snapshot.jsonl`, count entries, and prompt "restore N panes from <ts>?" via `wezterm.action.PromptInputLine` or a fuzzy picker.
- Pairs with `gui-startup` for GUI-side handling.
- **This eliminates `npm run restore-session` as a manual step.**

### Lua plugin distribution

- WezTerm plugins load via `wezterm.plugin.require('https://github.com/...')` — fetched directly from git
- We could publish `wolverin0/wezbridge.wezterm` as a lua plugin and let users `require` it from their `wezterm.lua`
- That's the "wezterm-native install" path — no separate Node daemon required if we move snapshot logic into Lua

### CLI subcommands we don't use

| Command | What we'd use it for |
|---|---|
| `wezterm cli spawn --new-window --workspace=<name>` | Group restored panes by workspace (resurrect.wezterm pattern) |
| `wezterm cli list-clients` | See connected mux clients — useful for debugging the 10054 |
| `wezterm cli proxy` | Tunnel a remote mux over a local Unix domain — alternative to channel-plugin pattern? |
| `wezterm cli set-tab-title --title-format` | Persist titles across restore |
| `wezterm cli zoom-pane --zoom` | Restore zoom state on restore |

`wezterm cli record` and `wezterm cli replay` are NOT for session restore — they record terminal output streams for playback (ttyrec-like). Different feature.

## Phase 3 — Release lag analysis

```
Last release tag: 20240203-110809-5046fc22 (2024-02-03)
Current main HEAD: ahead by 804 commits as of 2026-05-08
Gap: ~15 months of unreleased changes
```

The maintainer (wez) has continued committing actively but hasn't cut a release. Implications:

- Anyone using a stable release is missing 15 months of fixes (including possibly the PDU OOM fix when it lands).
- Running nightly = running unreleased code, but it's actively maintained.
- **Building from source** is the supported path for power users; `cargo install --path .` from a checkout of `main`.
- For us: building wezterm from source on this Windows box is the cleanest path to (a) test if recent commits silently fixed our 10054 issue, (b) prototype the PDU-size-validation fix for #7527.

## Phase 4 — Ranked recommendations

### Tier A — High leverage, low cost

1. **Add our 10054 repro to issue #7527.** ~15 min. Costs nothing, helps maintainer triage. Our `WEZTERM_LOG=...local=off` env var is the suppressing band-aid; the upstream fix would actually solve the crashes.
2. **Replace `captureProcessCmdline()` PowerShell call with `pane:get_foreground_process_info()` once we have a Lua plugin layer.** Eliminates ~50 LoC of cross-platform shell-out + the spawn-powershell-per-pane-per-tick overhead.

### Tier B — Medium cost, big UX win

3. **Build a `wezbridge.wezterm` Lua plugin** that hooks `mux-startup` and prompts "restore last snapshot?" using the JSONL log v3.4.0 already produces. This is the user's "no extra commands" demand resolved upstream-style. Estimated 100-200 LoC of Lua. Co-existence with v3.4.0 Node daemon: the daemon keeps writing snapshots; the Lua plugin reads them on mux-startup.
4. **Build wezterm from source** on this box once and run that binary. Tests whether 800+ commits since release fixed the 10054. ~30 min Cargo build. If it does, we drop the env-var workaround.

### Tier C — Long-tail / contribution

5. **Submit PR for #7527** with PDU size validation. Conceptually simple; reading the issue suggests it's a `bytes_capacity > MAX_REASONABLE_PDU` check before allocating. Best-case: upstream merges, our crashes go away for everyone. Worst-case: we maintain a fork.
6. **Consider upstreaming v3.4.0's cmdline-capture design** as a starting point for #3237's "save the current layout" feature. The `argv` field in `pane:get_foreground_process_info()` already exists — what's missing is the orchestration around it. Lower priority than (1)-(4).

### Skip

- `wezterm cli record/replay` — different feature, not session save.
- Migrating to resurrect.wezterm — it doesn't capture cmdline args; we'd lose what makes v3.4.0 useful for the OmniClaude pattern.

## Open questions for the user

1. Worth building wezterm from source as a test? (~30 min Cargo)
2. Worth investing in a Lua plugin layer that wraps our v3.4.0 (~half day)?
3. Want to comment on #7527 with our repro? (~15 min, I can draft)
4. Want to attempt the PDU-validation patch? (~few hours, includes building from source)

No code changes will be made until you choose a direction.

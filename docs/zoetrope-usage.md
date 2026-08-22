# zoetrope (zoe) — Claude Code session flow-graph viewer, installed for fleet audits
> Covers: install location, live-follow vs replay vs headless inspect, transcript paths.
> Binary: `zoe.exe` v0.1.0 (prebuilt x86_64-pc-windows-msvc) at `C:/Users/pauol/.cargo/bin/zoe.exe` (on PATH).
> Source: https://github.com/furkankly/zoetrope (Rust, ZERO network deps — transcripts never leave the machine).
> Key commands: `zoe` (follow cwd's live session) · `zoe <file.jsonl>` (replay) · `zoe <dir>` (follow project) · `zoe inspect <file>` (headless tree, agent-safe, no TTY needed).
> Transcripts live under `C:/Users/pauol/.claude/projects/<slug>/*.jsonl` (top-level = sessions, `subagents/` = spawned agents).
> Read this when: auditing an incident, replaying a pane's session, or wiring headless inspection into orchestrator tooling.

## Install (done 2026-08-22, slice A3)

Prebuilt Windows binary from the v0.1.0 GitHub release (`zoetrope-0.1.0-x86_64-pc-windows-msvc.zip`), `zoe.exe` copied into `C:/Users/pauol/.cargo/bin/` (already on PATH). No cargo build needed. Note: upstream ships no `.sha512`/`.asc` for the Windows asset (they exist only for macOS/Linux), so the download was not signature-verified. To upgrade later: download the newer release zip, or `cargo install zoetrope`.

```
$ zoe --version
zoe 0.1.0
```

## Modes

- **Live follow (TUI):** `zoe` in a project dir, or `zoe C:/Users/pauol/.claude/projects/<slug>` — ratatui flow graph of the running session. Needs a real terminal; do NOT launch from an agent without a TTY.
- **Replay (TUI):** `zoe <file.jsonl>` plays a recording from the start; `--speed N` (default 8.0), `--follow` to jump to the live edge. Scrub/pause/go-live available once open.
- **Headless inspect (agent-safe):** `zoe inspect <file.jsonl>` prints the session tree + info to stdout and exits — the mode orchestrator/audit tooling should call.

## Smoke test (2026-08-22)

```
$ zoe inspect C:/Users/pauol/.claude/projects/G---OneDrive-OneDrive-Desktop-Py-Apps-wezbridge/a71a3024-0db4-4cee-9871-bc008eb98690.jsonl
session a71a3024-... — Ejecutar orquestador de flota con handoff ...
  mode: normal · permission: bypassPermissions
  1 agent(s), 60 tool call(s) · 0 queued · 2 file edit(s)
  ◌ [main] main  (idle) — id=main
      model: claude-opus-4-8
      tools: 60 (55✓ 5✗ 0⏳)   tokens: 78512
```

Exit code 0. Output includes per-agent model, tool success/fail counts, and token totals — useful signals for the daily Meta review and incident replay.

Large-file check (same day): a 14.8 MB transcript (`...whatsappbot-final/19aee61d-*.jsonl`, main + 5 workflow subagents) inspected in **0.13 s**, exit 0 — headless inspect scales fine to the biggest session files in `~/.claude/projects`.

## Rules

- Transcripts are private session data: never upload them anywhere (zoetrope itself makes zero network calls; keep it that way — the browser WASM build at zoetrope.furkankly.dev is NOT for our transcripts).
- For fleet incident replay: find the pane's project slug under `~/.claude/projects/`, pick the session `.jsonl` by mtime, then `zoe <file>` (human) or `zoe inspect <file>` (agent).

# OmniClaude-via-Telegram setup

The "best version" of wezbridge: control the swarm from your phone, no browser UI required.

## What you'll have when this is set up

- **One WezTerm window** with multiple panes
- **One pane = OmniClaude** (your phone-facing controller). DMs to your bot reach it; it has `mcp__wezbridge__*` to spawn and command worker panes.
- **N panes = workers**. Each one's output streams to a dedicated Telegram forum topic.
- **Your phone** reads workers via the topics, sends commands via DM to OmniClaude.
- **No dashboard, no browser.** The `:4200` daemon stays headless (backs the MCP server).

```
   Your phone (Telegram)
        │  DM to bot                  forum topics (1 per worker)
        │                                    ▲
        ▼                                    │ outbound only
   ┌─────────────────────────────────────────────┐
   │ WezTerm                                     │
   │                                             │
   │  pane-1: OmniClaude  ◀─── inbound DMs ──── channel plugin
   │      │                                      │
   │      │ mcp__wezbridge__send_prompt          │
   │      ▼                                      │
   │  pane-2 worker, pane-3 worker, ...  ────▶  telegram-streamer.cjs
   │                                             │
   └─────────────────────────────────────────────┘
```

## Prerequisites

You should already have these from your earlier setup:

- WezTerm installed; `wezterm cli list` works
- Claude Code installed
- `wezbridge` MCP registered (`claude mcp list` shows it)
- The dashboard daemon runs (`npm run dashboard` from the wezbridge repo) — required because `mcp__wezbridge__*` tools fetch `/api/panes` against it
- A Telegram bot with the token at `~/.claude/channels/telegram/.env` (keys: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_GROUP_ID`)
- A Telegram **group with Topics enabled**, and a `~/.omniclaude/telegram-topics.json` mapping `{ project_name: topic_id, ..., _group_id: "<chat_id>" }`

If any of these is missing, see the main [README.md](../README.md) Quick start.

## Step 1 — Start the streamer (outbound: panes → Telegram topics)

The streamer polls every wezterm pane and posts each one's output to its forum topic. **Start it before launching panes** so nothing is missed.

```bash
# from wezbridge repo root, via the persistent launcher:
scripts/start-telegram-streamer.cmd     # Windows

# or directly, for one-shot debugging:
node src/telegram-streamer.cjs
```

For auto-start on Windows login (no admin), copy `start-telegram-streamer.cmd` to `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\`.

To verify it's running, watch a Telegram topic — the streamer posts a heartbeat-style edited message per pane that updates every ~10 seconds.

## Step 2 — Launch the OmniClaude pane (inbound: DMs → controller)

This is the pane that will receive your phone DMs and spawn workers.

```bash
# In a fresh WezTerm pane, point it at the project root you want as the
# orchestrator's home (any project — OmniClaude can spawn into others):
cd /your/project/root

# Launch Claude Code with the telegram channel plugin bound:
claude --channels plugin:telegram@claude-plugins-official
```

The `--channels` flag is what makes inbound DMs reach this session. Without it, your DMs go to the bot but the channel plugin has no paired session to forward them to.

**Pair the session with your Telegram account:**

1. From your phone, DM your bot any text.
2. The bot replies with a 6-character pairing code.
3. In the OmniClaude pane: `/telegram:access pair <code>` — done. Future DMs land in this session.

(Pairing is one-time per allowlisted user; persisted at `~/.claude/channels/telegram/access.json`.)

## Step 3 — Spawn worker panes from OmniClaude

Now the OmniClaude pane is your full control surface. From your phone, send a DM like:

> spawn a coder pane in the wezbridge project to fix issue #42

OmniClaude will use `mcp__wezbridge__spawn_session` to create a new WezTerm pane, send a prompt, and reply to you on Telegram. The streamer (already running from step 1) will start mirroring that pane's output to its dedicated topic. You can then jump into that topic on your phone to read along.

Useful MCP tools OmniClaude has at hand:

- `spawn_session({ cwd, persona?, prompt? })` — new pane
- `send_prompt({ pane_id, text })` + `send_key({ pane_id, key: "enter" })` — drive an existing pane
- `read_output({ pane_id, lines })` — peek at scrollback
- `discover_sessions()` — list all panes with state (idle/working/permission/stuck)
- `auto_handoff({ pane_id })` — when a pane's context fills, do the readiness-check → /handoff → /clear → resume dance

## Step 4 — Daily usage rhythm

- **Mornings:** open WezTerm, OmniClaude pane is already there (auto-restart via your launcher). Streamer too.
- **From the couch / commute:** DM the bot, OmniClaude spawns a worker, the worker's topic shows live progress.
- **Permission prompts:** the channel plugin forwards permission UIs to your DM. You answer 1/2/3 from your phone.
- **Pane fills its context:** OmniClaude can detect this via `discover_sessions` (it returns `ctx_pct`), then call `auto_handoff` — the worker writes a handoff file, gets cleared, fresh session resumes.

## Troubleshooting

**Streamer started but no topics getting posts.** Verify `~/.omniclaude/telegram-topics.json` has the project names matching the panes' detected projects (the streamer maps pane → project via `cwd`, then project → topic). New project? Add it to the JSON, then restart the streamer.

**OmniClaude pane doesn't receive DMs.** You probably forgot the `--channels` flag, or the pairing didn't complete. `claude --channels plugin:telegram@claude-plugins-official` is mandatory; `claude` alone gives you the outgoing reply tools but no inbound. Verify with `<channel source="telegram" ...>` showing up as a system-reminder when you DM.

**Both streamer and channel plugin running but DMs going missing.** They race for `getUpdates`. The streamer's inbound polling is deliberately disabled (see `src/telegram-streamer.cjs` lines 1112-1117) — if you re-enabled it, that's why. Disable it again.

**Goose-related processes appearing.** Unrelated to wezbridge. There's likely a `goosed` Windows service from an earlier experiment; remove with `sc stop goosed && sc delete goosed`.

## What this is NOT

- **Not the deprecated dashboard UI.** That UI was vaporware and removed in v3.2.1 — see [`src/DEPRECATED.md`](../src/DEPRECATED.md). The `:4200` daemon is required as a backend for the MCP server but serves no browser UI.
- **Not the orchestra-goose Tier-2 autonomy experiment** (April 30 / May 3 2026, reverted). That preserved the OmniClaude/Telegram pattern at git tag `omniclaude-pre-rollback` (commit `acd3460`) — check that out if you ever want to revive that ambition.
- **Not Anthropic Managed Agents.** Those exist hosted at $0.08/session-hour; this stack does the same primitives (rubric grader, A2A heartbeat, command guards, sidecar audit panes — see v3.2.0 release) for free.

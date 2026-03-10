# WezBridge

Control Claude Code sessions from Telegram. Live terminal streaming, project discovery, code diffs, permission handling — your phone becomes Mission Control.

```
Telegram "Mission Control"
  ├── Topic: "my-backend"   ←→ WezTerm pane 3 (Claude Code)
  ├── Topic: "my-frontend"  ←→ WezTerm pane 5 (Claude Code)
  └── Topic: "my-api"       ←→ WezTerm pane 7 (Claude Code)
```

## What's New in V2.1

- **Completion cards** — One self-updating message per session. No more chat spam.
- **Auto-delete prompts** — Your messages vanish after 3s. Clean topic, zero bloat.
- **Smart `/reconnect`** — After bot restart, pick a running WezTerm pane to relink.
- **Colored logs** — Bot terminal output with ANSI colors and semantic tags.
- **Cross-platform paths** — Works on Windows, Git Bash, and WSL automatically.

### V2.0 features

- **`/live`** — Real-time terminal streaming. Watch Claude work from your phone.
- **`/projects`** — Browse all your Claude projects. Tap to spawn.
- **Code diffs** — See what changed after every Claude response.
- **Permission buttons** — Approve/reject Claude's tool use from Telegram.
- **Session persistence** — Sessions survive bot restarts.
- **Photo support** — Send screenshots directly to Claude.
- **Plugin system** — Extend WezBridge with custom plugins.

## How it works

1. WezBridge runs alongside your WezTerm terminal
2. Each Claude Code session lives in a WezTerm pane
3. The bot polls each pane for the `❯` prompt (meaning Claude finished)
4. When Claude finishes, the response is parsed and sent to Telegram
5. Messages you type in a topic are injected into Claude as prompts
6. `/live` mode streams the terminal in real-time (5s updates)

## Prerequisites

- [WezTerm](https://wezfurlong.org/wezterm/) installed with mux server running
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`claude` CLI) installed
- [Node.js](https://nodejs.org/) 18+
- A Telegram bot token (from [@BotFather](https://t.me/BotFather))
- A Telegram group with **Topics enabled**

## Quick Start

```bash
git clone https://github.com/wolverin0/wezbridge.git
cd wezbridge
npm install
cp .env.example .env
# Edit .env with your bot token and group ID
npm start
```

## Setup

### 1. Create a Telegram bot

1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot` and follow the prompts
3. Save the bot token

### 2. Create a forum group

1. Open Telegram → **New Group**
2. Add your bot + one other member (removable after)
3. Name it (e.g. "Mission Control") and create
4. Open group **Settings**:
   - **Topics** → toggle **On**
   - **Administrators** → tap bot → enable **Manage Topics**, **Send Messages**, **Delete Messages**
5. Get the chat ID:
   ```bash
   TELEGRAM_BOT_TOKEN=your_token node src/telegram-bot.cjs
   # Send any message in the group
   # Bot logs: [wezbridge] Message from chat -100xxxxxxxxxx
   ```

### 3. Start WezTerm mux

```bash
# Start the multiplexer
wezterm start --front-end MuxServer &

# Connect visible GUI
wezterm connect unix
```

### 4. Configure and start

```bash
# Edit .env with your token and group ID
npm start
```

## Commands

### Session Management

| Command | Description |
|---------|-------------|
| `/spawn <project> [--continue] [--yolo]` | Start Claude Code session in a new topic |
| `/kill` | Kill session in current topic |
| `/reconnect` | Re-link topic to a running WezTerm pane (see below) |
| `/status` | List all active sessions with pane IDs |

### Live Monitoring

| Command | Description |
|---------|-------------|
| `/live` | Toggle real-time terminal streaming |
| `/peek` | Snapshot of last 60 terminal lines |
| `/dump` | Full 500-line scrollback as document |

### Project Discovery

| Command | Description |
|---------|-------------|
| `/projects` | Browse all Claude projects (tap to spawn) |
| `/sessions <name>` | List sessions with cost, health, preview |
| `/costs` | Token/cost summary across all sessions |

### History

| Command | Description |
|---------|-------------|
| `/history` | Last 5 prompt/response pairs |
| `/replay` | Re-send last response |
| `/export` | Full session history as markdown |

### Utility

| Command | Description |
|---------|-------------|
| `/compact` | Send `/compact` to Claude |
| `/help` | Show all commands |

## Completion Cards

Every time Claude finishes responding, WezBridge sends (or updates) a **completion card** — a single compact message that replaces itself:

```
━━ my-backend ━━
✅ Idle | 12s ago

● Updated src/auth.ts
  Added JWT refresh token logic with 7-day expiry...

📊 3 files changed, +45 -12

[Continue]  [Run Tests]
[Commit]    [View Diff]
[Compact]   [Review]
[📄 Full Response]
```

**How it works:**
- On the first completion, a new card message is sent to the topic
- On every subsequent completion, the **same message is edited** in-place
- No chat bloat — one message per session, always up-to-date
- If the original message is too old to edit, a new card is created

**Card content:**
- **Header**: Session name with decorative borders
- **Status line**: Icon (✅ idle, 🔓 needs permission, ⏯ continue?) + time since last activity
- **Response preview**: First 600 characters of Claude's output, cleaned of ANSI codes
- **Diff stat**: One-line summary of uncommitted changes (if any)

**Utility buttons:**
- `📄 Full Response` — Sends the complete response. Under 3KB: inline `<pre>` block. Over 3KB: as a `.md` document attachment
- `📊 View Diff` — Sends the full git diff. Under 3KB: inline formatted. Over 3KB: as a `.diff` document attachment

### Action Buttons

Context-aware buttons appear on every completion card:

**Normal (idle):**
```
[Continue]  [Run Tests]
[Commit]    [View Diff]
[Compact]   [Review]
[📄 Full Response]
```

**Permission prompt (y/n):**
```
[✅ Yes]  [✅ Always]  [❌ No]
[View Details]
[📄 Full Response]
```

**Continuation prompt:**
```
[Continue]  [Status]
[📄 Full Response]
```

Clicking an action button clears all buttons from that card to prevent stacking, then starts a thinking timer while Claude works.

## Auto-Delete Prompts

When you type a message in a session topic:

1. The message is sent to Claude as a prompt
2. A brief "Sent to Claude..." acknowledgment appears
3. After 3 seconds, **both your message and the ack are deleted**

This keeps the topic clean — only completion cards remain. Your messages are still in Telegram's chat history if you scroll up or search.

## Live Terminal Streaming

`/live` streams your terminal to Telegram in real-time:

- Updates every 5 seconds
- Only sends updates when content changes (hash-based)
- Edits a single message (no spam)
- Shows last 50 lines in `<pre>` block
- Auto-suppresses "thinking" timer and ack messages

Toggle on with `/live`, toggle off with `/live` again.

## Project Discovery

V2 auto-discovers all your Claude projects from `~/.claude/projects/`:

```
/projects

elbraserito        | 12 sessions | 2m ago
openclaw2claude    | 34 sessions | 15m ago
solmiasoc          |  8 sessions | 1h ago
[tap name to spawn]
```

No more hardcoded project maps. The `WEZBRIDGE_PROJECTS` env var is still supported as an override.

## Reconnect

`/reconnect` re-links a Telegram topic to a running WezTerm pane. Two modes:

**Session exists** (normal reconnect):
```
You: /reconnect
Bot: Reconnected: my-backend — ✅ Idle (3m)
     Pane: 5
     [last response preview]
     [Continue] [Run Tests] [Commit]
```

Resets the polling state, re-reads the terminal, and shows the current status with action buttons.

**No session** (after bot restart, or new topic):
```
You: /reconnect
Bot: Select a pane to reconnect:
     [Pane 3: Claude Code]
     [Pane 5: Claude Code]
     [Pane 7: bash]
```

Scans all WezTerm panes and shows them as buttons. Tap one to link it to this topic. A new session is created and polling starts immediately.

This means you never need to `/spawn` again after a bot restart — just `/reconnect` and pick the pane.

## Session Persistence

Sessions survive bot restarts:

- State saved to `.wezbridge-state.json` every 30s and on graceful shutdown
- On startup, validates that WezTerm panes still exist (dead panes are skipped)
- Re-creates session objects and topic mappings from saved state
- Graceful save on SIGINT/SIGTERM
- If panes were killed while the bot was down, use `/reconnect` to link new panes

## Plugin System

Drop `.cjs` files in `plugins/` to extend WezBridge:

```javascript
module.exports = {
  name: 'my-plugin',
  register(ctx) {
    ctx.registerCommand('/hello', (msg) => {
      ctx.sendMsg(msg.chat.id, 'Hello from plugin!', msg.message_thread_id);
    });

    ctx.on('session:completion', ({ session, response }) => {
      // React to completions
    });
  }
};
```

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌──────────────┐
│  Telegram    │────▶│  WezBridge   │────▶│  WezTerm     │
│  (phone)     │◀────│  (Node.js)   │◀────│  (terminal)  │
└─────────────┘     └──────────────┘     └──────────────┘
                          │
                    polls every 3s
                    for ❯ prompt
```

**Files:**

| File | Lines | Purpose |
|------|-------|---------|
| `telegram-bot.cjs` | ~1900 | Main bot: commands, completion cards, live streaming, buttons, state |
| `session-manager.cjs` | ~430 | Session lifecycle, completion detection, stability checks |
| `wezterm.cjs` | ~220 | WezTerm CLI wrapper with multi-env path detection |
| `output-parser.cjs` | ~350 | Terminal output → Telegram HTML conversion |
| `diff-extractor.cjs` | ~170 | Git diff operations (stat, unified, commits) |
| `project-scanner.cjs` | ~400 | Claude project discovery with path encoding |
| `notification-manager.cjs` | ~120 | Notification batching and priority |
| `plugin-loader.cjs` | ~110 | Plugin auto-discovery and lifecycle |
| `telegram-rate-limiter.cjs` | ~70 | Per-chat rate limiting for Telegram API |
| `bot-watchdog.cjs` | ~50 | Auto-restarts the bot on crash |
| `test-connection.cjs` | ~70 | Connection verification script |

## Terminal Output

The bot uses colored ANSI output for readable logs:

```
━━━ WezBridge V2.1 ━━━

[bot] Group: -100xxxxxxxxxx
[bot] Poll: 3000ms
[bot] Notify: all
[plugin] Loaded: example
[bot] Projects: 38 discovered
[state] Restored: topic 9291 <-> wez-1 (openclaw2claude)
✓ Bot is running — send /help in the group

[poll] 1 session(s) completed
[>>>] openclaw2claude → topic 9291
```

Tags are color-coded: `[bot]` cyan, `[poll]` blue, `[>>>]` green (outgoing), `[<<<]` magenta (incoming), `[ERR]` red, `[state]` dim, `[live]` yellow.

Stability detection logs are suppressed to one line per state change (no more spam).

## Troubleshooting

### Bot doesn't detect when Claude finishes

The bot checks the last 15 lines of terminal output for the `❯` prompt. If your status bar is taller, increase `DETECTION_WINDOW` in `session-manager.cjs`.

### 409 Conflict errors

Only one bot instance can poll at a time:

```bash
pkill -f "telegram-bot.cjs"
sleep 30
npm start
```

### WezTerm CLI errors

Make sure the mux server is running:

```bash
wezterm start --front-end MuxServer
wezterm cli list  # should show panes
```

### Sessions lost on restart

Check that `.wezbridge-state.json` exists in the project root. The bot saves state every 30s and on graceful shutdown. If WezTerm panes were killed, those sessions can't be restored — use `/reconnect` to link to new panes.

### `/reconnect` shows no panes

Make sure WezTerm mux server is running and `wezterm cli list` returns panes. If running under Git Bash or WSL, the bot auto-detects the WezTerm path but you can also set `WEZTERM_PATH` in your `.env` file.

### Live mode not updating

`/live` requires the session to be linked to a topic. If you see "no session", use `/reconnect` or spawn a new session first.

### Bot spawns in wrong directory

V2.1 uses `encodePathLikeClaude()` to match project directories. If a project has deep subfolder sessions, the bot walks up the path to find the project root. Set `WEZBRIDGE_PROJECTS` env var for manual overrides.

## Recommended WezTerm Config

Add to `~/.wezterm.lua` for best experience:

```lua
config.enable_scroll_bar = true
config.scrollback_lines = 10000
config.unix_domains = { { name = 'unix' } }

config.keys = {
  { key = 'v', mods = 'CTRL', action = wezterm.action.PasteFrom 'Clipboard' },
  { key = 'PageUp', mods = 'NONE', action = wezterm.action.ScrollByPage(-1) },
  { key = 'PageDown', mods = 'NONE', action = wezterm.action.ScrollByPage(1) },
}

config.mouse_bindings = {
  { event = { Down = { streak = 1, button = 'Right' } }, mods = 'NONE',
    action = wezterm.action.PasteFrom 'Clipboard' },
}
```

## OpenClaw Integration

WezBridge was built as part of the [OpenClaw](https://github.com/wolverin0/openclaw2claude) ecosystem — a framework for orchestrating multiple Claude Code sessions from a central control plane.

## License

MIT

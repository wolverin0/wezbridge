# WezBridge

Control Claude Code sessions from Telegram. Live terminal streaming, project discovery, code diffs, permission handling — your phone becomes Mission Control.

```
Telegram "Mission Control"
  ├── Topic: "my-backend"   ←→ WezTerm pane 3 (Claude Code)
  ├── Topic: "my-frontend"  ←→ WezTerm pane 5 (Claude Code)
  └── Topic: "my-api"       ←→ WezTerm pane 7 (Claude Code)
```

## What's New in V2

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
| `/spawn <project> [--continue] [--yolo]` | Start Claude Code session |
| `/kill` | Kill session in current topic |
| `/reconnect` | Re-sync after working on PC |
| `/status` | List all active sessions |

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

## Action Buttons

After Claude responds, context-aware buttons appear:

**Normal (idle):**
```
[Continue] [Run Tests] [Commit]
```

**Permission prompt (y/n):**
```
[Yes] [Always (!)] [No] [View Details]
```

**Numbered selector (❯ 1. Yes / 2. No):**
```
[1. Yes] [2. No]
```

Buttons auto-clear after clicking to prevent stacking.

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

## Session Persistence

Sessions survive bot restarts:

- State saved to `.wezbridge-state.json` every 30s
- On startup, validates panes still exist
- Re-creates session objects and topic mappings
- Graceful save on SIGINT/SIGTERM

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
| `telegram-bot.cjs` | ~1600 | Main bot: commands, live streaming, buttons, state |
| `session-manager.cjs` | ~400 | Session lifecycle, completion detection, permissions |
| `wezterm.cjs` | ~160 | WezTerm CLI wrapper (pane management, text I/O) |
| `output-parser.cjs` | ~350 | Terminal output → Telegram HTML conversion |
| `diff-extractor.cjs` | ~170 | Git diff operations (stat, unified, commits) |
| `project-scanner.cjs` | ~380 | Claude project discovery from ~/.claude/projects/ |
| `notification-manager.cjs` | ~120 | Notification batching and priority |
| `plugin-loader.cjs` | ~110 | Plugin auto-discovery and lifecycle |
| `telegram-rate-limiter.cjs` | ~70 | Per-chat rate limiting for Telegram API |
| `bot-watchdog.cjs` | ~50 | Auto-restarts the bot on crash |
| `test-connection.cjs` | ~70 | Connection verification script |

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

Check that `.wezbridge-state.json` exists in the project root. The bot saves state every 30s and on graceful shutdown. If WezTerm panes were killed, those sessions can't be restored.

### Live mode not updating

`/live` requires the session to be linked to a topic. If you see "no session", use `/reconnect` or spawn a new session first.

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

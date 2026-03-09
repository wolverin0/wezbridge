# WezBridge

Control Claude Code sessions from Telegram. Each session gets its own Forum Topic — send prompts from your phone, receive formatted responses with action buttons.

```
Telegram Group "Mission Control"
  ├── Topic: "my-backend"   ←→ WezTerm pane 3 (Claude Code)
  ├── Topic: "my-frontend"  ←→ WezTerm pane 5 (Claude Code)
  └── Topic: "my-api"       ←→ WezTerm pane 7 (Claude Code)
```

## How it works

1. WezBridge runs alongside your WezTerm terminal
2. Each Claude Code session lives in a WezTerm pane
3. The bot watches each pane for the `❯` prompt (meaning Claude finished)
4. When Claude finishes, the response is parsed and sent to Telegram
5. Messages you type in a topic are injected into Claude as prompts

## Prerequisites

- [WezTerm](https://wezfurlong.org/wezterm/) installed with mux server running
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`claude` CLI) installed
- [Node.js](https://nodejs.org/) 18+
- A Telegram bot token (from [@BotFather](https://t.me/BotFather))
- A Telegram group with **Topics enabled** (Settings → Topics → On)

## Setup

### 1. Create a Telegram bot

1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot` and follow the prompts
3. Save the bot token

### 2. Create a forum group

1. Create a new Telegram group (or use an existing one)
2. Go to group Settings → Topics → Enable
3. Add your bot to the group as **admin** with "Manage Topics" permission
4. Note the group chat ID (the bot logs it when it receives a message)

### 3. Start WezTerm mux server

```bash
# Start the multiplexer (keeps panes alive even when GUI closes)
wezterm start --front-end MuxServer &

# Connect a visible GUI to the mux
wezterm connect unix
```

### 4. Install and configure WezBridge

```bash
git clone https://github.com/youruser/wezbridge.git
cd wezbridge
npm install

# Copy and edit the config
cp .env.example .env
```

Edit `.env`:
```env
TELEGRAM_BOT_TOKEN=your_bot_token_here
TELEGRAM_GROUP_ID=-100xxxxxxxxxx

# Optional: map short names to project paths
WEZBRIDGE_PROJECTS={"backend":"/home/user/projects/backend","frontend":"/home/user/projects/frontend"}
```

### 5. Test the connection

```bash
npm test
```

### 6. Start the bot

```bash
npm start
```

## Usage

### Telegram commands

| Command | Description |
|---------|-------------|
| `/spawn <project> [--continue]` | Start a new Claude Code session |
| `/kill` | Kill the session (use in a topic) |
| `/status` | List all active sessions |
| `/help` | Show available commands |

### Action buttons

After Claude responds, you'll see inline buttons:

- **Continue** — Send Enter (accept suggestions, continue generation)
- **Run Tests** — Sends "run the tests" to Claude
- **Commit** — Sends "commit the changes" to Claude
- **Status** — Show Claude's current output

### Seeding existing sessions

If Claude Code is already running in a WezTerm pane, you can link it to a topic:

```bash
# --seed topicId:paneId:projectName
npm start -- --seed 12345:1:my-project
```

To find the topic ID: right-click a topic in Telegram → Copy Topic Link → the number after the last `/` is the topic ID.

To find the pane ID: `wezterm cli list`

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌──────────────┐
│  Telegram    │────▶│  WezBridge   │────▶│  WezTerm     │
│  (your phone)│◀────│  (Node.js)   │◀────│  (terminal)  │
└─────────────┘     └──────────────┘     └──────────────┘
                          │                     │
                    polls every 3s        Claude Code
                    for ❯ prompt          running here
```

**Files:**

| File | Purpose |
|------|---------|
| `src/telegram-bot.cjs` | Main bot: commands, message routing, completion loop |
| `src/session-manager.cjs` | Session lifecycle, prompt injection, completion detection |
| `src/wezterm.cjs` | WezTerm CLI wrapper (pane management, text I/O) |
| `src/output-parser.cjs` | Terminal output → Telegram HTML conversion |
| `src/telegram-rate-limiter.cjs` | Per-chat rate limiting for Telegram API |
| `src/bot-watchdog.cjs` | Auto-restarts the bot on crash |
| `src/test-connection.cjs` | Connection verification script |

## Troubleshooting

### Bot doesn't detect when Claude finishes

Claude Code has a status bar (~7 lines) below the `❯` prompt. The bot checks the last 15 lines of terminal output. If your status bar is taller, increase `DETECTION_WINDOW` in `session-manager.cjs`.

### 409 Conflict errors

Only one bot instance can poll at a time. Kill all existing instances before restarting:

```bash
# Find and kill existing bot processes
pkill -f "telegram-bot.cjs"
# Wait 30 seconds for Telegram to release the polling lock
sleep 30
npm start
```

### WezTerm CLI errors

Make sure the mux server is running:

```bash
wezterm start --front-end MuxServer
wezterm cli list  # should show panes
```

### Text appears but Enter doesn't work

WezBridge sends `\r` via `--no-paste` mode. If your shell doesn't respond, check that WezTerm's mux is properly connected:

```bash
wezterm connect unix
```

## License

MIT

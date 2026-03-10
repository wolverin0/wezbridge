# WezBridge

Control Claude Code sessions from Telegram. Live streaming, voice prompts, split panes, inline status — your phone becomes Mission Control.

```
Telegram "Mission Control"
  ├── Topic: "my-backend"   ←→ WezTerm pane 3 (Claude Code)
  ├── Topic: "my-frontend"  ←→ WezTerm pane 5 (Claude Code)
  └── Topic: "my-api"       ←→ WezTerm pane 7 (Claude Code)
```

## What's New in V3

- **Voice prompts** — Send voice notes → Whisper transcribes → Claude receives text
- **Native streaming** — Bot API 9.5 `sendMessageDraft` for smoother live output
- **Message reactions** — ⏳ while working, ✅ on completion, ❓ on permission
- **Split panes** — `/split` and `/split v` for side-by-side sessions
- **Workspaces** — `/workspace` to group sessions by project
- **Inline mode** — `@wezbridge_bot` for quick status from any chat
- **PM2 management** — Production process manager with log rotation
- **Smart reconnect** — Auto-spawns sessions after PC reboot
- **GitHub webhooks** — Push/PR/CI notifications in session topics
- **ntfy.sh** — Backup notifications when Telegram is unavailable
- **SSH domains** — `/remote` to spawn sessions on remote servers

### V2.x features

- **`/live`** — Real-time terminal streaming from your phone
- **`/projects`** — Browse all Claude projects, tap to spawn
- **Completion cards** — One self-updating message per session
- **Code diffs** — See what changed after every response
- **Permission buttons** — Approve/reject tool use from Telegram
- **Session persistence** — Survives restarts
- **Photo/document support** — Send screenshots to Claude
- **Plugin system** — Extend with custom plugins

## How it works

1. WezBridge runs alongside WezTerm
2. Each Claude Code session lives in a WezTerm pane
3. The bot polls each pane for the `❯` prompt (meaning Claude finished)
4. Responses are parsed and sent to Telegram as completion cards
5. Messages you type in a topic are injected as prompts
6. `/live` streams the terminal in real-time via `sendMessageDraft`

## Prerequisites

- [WezTerm](https://wezfurlong.org/wezterm/) with mux server
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI
- [Node.js](https://nodejs.org/) 18+
- A Telegram bot token ([@BotFather](https://t.me/BotFather))
- A Telegram group with **Topics enabled**

## Quick Start

```bash
git clone https://github.com/wolverin0/wezbridge.git
cd wezbridge
npm install
cp .env.example .env   # Edit with your bot token and group ID
npm start              # Uses PM2 (recommended)
```

Or with the legacy watchdog:
```bash
npm run start:watchdog
```

## Commands

### Session Management

| Command | Description |
|---------|-------------|
| `/spawn <project> [--continue] [--yolo]` | Start session in a topic |
| `/kill` | Kill session in current topic |
| `/reconnect` | Re-link or auto-spawn after reboot |
| `/status` | List all active sessions |

### Live Monitoring

| Command | Description |
|---------|-------------|
| `/live` | Toggle real-time terminal streaming |
| `/peek` | Snapshot of last 60 lines |
| `/dump` | Full 500-line scrollback as document |

### Project Discovery

| Command | Description |
|---------|-------------|
| `/projects` | Browse all Claude projects (tap to spawn) |
| `/sessions <name>` | Session list with cost and health |
| `/costs` | Token/cost summary |

### WezTerm (V3)

| Command | Description |
|---------|-------------|
| `/split` | Split pane horizontally |
| `/split v` | Split pane vertically |
| `/workspace` | List workspaces |
| `/workspace <name>` | Switch workspace |
| `/remote [domain]` | Spawn on SSH domain (default: openclaw) |

### History & Utility

| Command | Description |
|---------|-------------|
| `/history` | Last 5 prompt/response pairs |
| `/replay` | Re-send last response |
| `/export` | Full session history as document |
| `/compact` | Send `/compact` to Claude |
| `/help` | Show all commands |

### Inline Mode

Type `@wezbridge_bot` in **any** Telegram chat to see session status without opening the group.

### Voice Messages

Send a voice note in any session topic — Whisper API transcribes it and sends the text as a prompt to Claude. Shows the transcript before sending.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Yes | Bot token from @BotFather |
| `TELEGRAM_GROUP_ID` | Yes | Forum group chat ID |
| `TELEGRAM_POLL_MS` | No | Poll interval (default: 3000) |
| `OPENAI_API_KEY` | For voice | Whisper API key |
| `GITHUB_WEBHOOK_SECRET` | No | Webhook HMAC verification |
| `NTFY_TOPIC` | For ntfy | ntfy.sh topic name |
| `NTFY_ENABLED` | For ntfy | Set to 'true' |
| `CLAWTROL_API_URL` | No | ClawTrol REST API URL |
| `CLAWTROL_API_TOKEN` | No | ClawTrol auth token |

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌──────────────┐
│  Telegram    │────▶│  WezBridge   │────▶│  WezTerm     │
│  (phone)     │◀────│  (Node.js)   │◀────│  (terminal)  │
└─────────────┘     └──────────────┘     └──────────────┘
       │                   │                     │
   voice notes        PM2 managed          splits/workspaces
   inline mode      GitHub webhooks        SSH domains
   reactions        ntfy.sh backup
```

**Files:**

| File | Purpose |
|------|---------|
| `telegram-bot.cjs` | Core bot: commands, streaming, buttons, state |
| `session-manager.cjs` | Session lifecycle, completion detection |
| `wezterm.cjs` | CLI wrapper: splits, workspaces, SSH |
| `output-parser.cjs` | Terminal output → Telegram HTML |
| `diff-extractor.cjs` | Git diff operations |
| `project-scanner.cjs` | Claude project discovery |
| `voice-handler.cjs` | Whisper API voice transcription |
| `github-webhook.cjs` | GitHub event formatter |
| `ntfy-notifier.cjs` | ntfy.sh backup notifications |
| `notification-manager.cjs` | Notification batching |
| `plugin-loader.cjs` | Plugin system |
| `telegram-rate-limiter.cjs` | Telegram API rate limiting |
| `bot-watchdog.cjs` | Legacy auto-restart watchdog |
| `ecosystem.config.cjs` | PM2 process management |

## WezTerm Config

Add to `~/.wezterm.lua`:

```lua
config.enable_scroll_bar = true
config.scrollback_lines = 10000
config.unix_domains = { { name = 'unix' } }

-- For /remote command (optional)
config.ssh_domains = {
  { name = "openclaw", remote_address = "192.168.100.186", username = "ggorbalan" },
}
```

## License

MIT

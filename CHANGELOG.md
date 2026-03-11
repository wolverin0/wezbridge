# Changelog

## [3.1.0] - 2026-03-11

### Added

**Telegram Mini App Dashboard** — Full mission control inside Telegram
- 4-tab dashboard: Sessions, Projects, Costs, Files
- Session cards with live SSE streaming terminal output viewer
- Action buttons: Continue, Tests, Commit, Compact, Kill
- Projects tab with search/filter, tap to spawn sessions directly
- Costs tab with real token usage and USD estimates (today/week/all time)
- Files tab with git diff browser — see changed files and expand diffs
- Telegram WebApp SDK integration (dark theme, haptic feedback)
- WebApp auth via initData HMAC-SHA256 validation (dev mode passthrough)
- Dashboard accessible via inline button from `/dashboard` in group
- Registered as BotFather Mini App

**Dashboard Spawn Integration** — Spawns from dashboard create Telegram topics
- `session:spawned-api` event bridges server → bot for topic creation
- Sessions spawned from dashboard get their own forum topic automatically

**Improved /reconnect** — Filters panes by project name
- Shows only panes matching the current topic's project
- Falls back to all Claude panes if no match

**New API Endpoints**
- `GET /api/projects` — list all Claude projects with friendly names
- `GET /api/costs` — cost summary (today/week/all time)
- `GET /api/session/:id/output` — one-shot terminal output
- `GET /api/session/:id/stream` — SSE live streaming output
- `GET /api/files?project=` — git status (changed files with +/- counts)
- `GET /api/files/diff?project=&file=` — file diff viewer
- `POST /api/spawn` — spawn session from dashboard

### Fixed

- Kill button now properly removes sessions (uses `sm.killSession()`)
- Continue action sends Enter key to actually resume Claude
- Spawn from `/projects` no longer crashes on deleted topics
- Session reuse sends to correct topic (catches stale topic errors)
- Cost parser now reads Claude JSONL usage format (was always $0)
- Project names show friendly names instead of encoded paths

## [3.0.0] - 2026-03-10

### Added

**Message Reactions** — Lightweight status on messages
- Hourglass (⏳) on your prompt while Claude works
- Checkmark (✅) on completion cards when done
- Question mark (❓) on permission prompts
- Uses Bot API `setMessageReaction` via raw API call

**Voice-to-Text** — Send voice notes as prompts
- Send a voice message in any session topic → Whisper transcribes → sends as prompt
- New file: `voice-handler.cjs` — OpenAI Whisper API integration
- Shows "Transcribing..." status, then the transcript before sending
- Language defaults to Spanish (configurable)
- Requires `OPENAI_API_KEY` env var
- Optional `form-data` package for upload (falls back to native fetch)

**Native Message Streaming** — Bot API 9.5 `sendMessageDraft`
- Live terminal output uses native draft streaming for smoother display
- Graceful fallback to `editMessageText` if `sendMessageDraft` is unavailable
- Draft cleared on stream end to remove typing indicator
- Per-stream `draftFailed` flag prevents retry loops

**GitHub Webhooks** — Push/PR/CI notifications in session topics
- New file: `github-webhook.cjs` — Express middleware for GitHub webhooks
- Formats push events (commits), PRs (open/close/merge), issues, workflow runs
- HMAC-SHA256 signature verification via `GITHUB_WEBHOOK_SECRET`
- Colored status icons per event type

**PM2 Process Management** — Production-grade process manager
- New file: `ecosystem.config.cjs` — replaces custom watchdog for production
- Exponential backoff restart (1s base), 500MB memory limit
- Log rotation (10MB per file, 5 retained)
- `npm start` now uses PM2 (`npm run start:watchdog` for legacy)

**Split-Pane Layouts** — Side-by-side sessions from Telegram
- `/split` — split current session's pane horizontally
- `/split v` — split vertically
- New functions: `splitHorizontal()`, `splitVertical()`, `activatePaneDirection()`

**WezTerm Workspaces** — Group sessions by project
- `/workspace` — list all WezTerm workspaces
- `/workspace <name>` — switch to a workspace
- New functions: `listWorkspaces()`, `switchWorkspace()`, `spawnInWorkspace()`

**Inline Mode** — Quick status from any chat
- Type `@wezbridge_bot` in any Telegram chat for session status
- Returns status cards with session name, project, pane ID, age
- Summary card with total/working/idle counts
- 10-second cache for snappy responses

**ntfy.sh Backup Notifications** — Redundant notification channel
- New file: `ntfy-notifier.cjs` — push notifications via ntfy.sh
- Pre-built: `notifyCompletion()`, `notifyError()`, `notifyPermission()`, `notifyStatus()`
- Configurable server, topic, and auth token
- Requires `NTFY_TOPIC` + `NTFY_ENABLED=true`

**WezTerm SSH Domains** — Remote terminal sessions
- `/remote [domain]` — spawn a pane on a remote SSH domain
- Defaults to `openclaw` domain (configurable in `~/.wezterm.lua`)
- New function: `spawnSshDomain()` in wezterm.cjs

**Smart Reconnect** — Auto-spawn on reboot
- `/reconnect` after PC reboot detects topic name → resolves project → auto-spawns
- No more "No running panes found" dead end
- `/projects` from inside a topic reuses that topic (no duplicate topics)

### Changed

- **Keyboard buttons** reorganized to 2 rows of 3 with emoji prefixes (▶️🧪💾📊🗜🔍)
- **Permission buttons** renamed: Yes→Approve, No→Reject with 🚫 icon
- **Project spawn buttons** prefixed with 🚀
- **Pane filter** improved — bare bash shells no longer shown in `/reconnect`
- `telegram-bot.cjs` — ~2400 lines (up from ~1900 in V2.1)
- `wezterm.cjs` — now exports 10 functions (up from 6)

### New Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENAI_API_KEY` | For voice | Whisper API transcription |
| `GITHUB_WEBHOOK_SECRET` | No | GitHub webhook HMAC verification |
| `NTFY_TOPIC` | For ntfy | ntfy.sh topic name |
| `NTFY_SERVER` | No | ntfy.sh server URL (default: https://ntfy.sh) |
| `NTFY_TOKEN` | No | ntfy.sh auth token |
| `NTFY_ENABLED` | For ntfy | Set to 'true' to enable |

### New Files

| File | Purpose |
|------|---------|
| `voice-handler.cjs` | Whisper voice transcription |
| `github-webhook.cjs` | GitHub webhook event formatter |
| `ntfy-notifier.cjs` | ntfy.sh backup notifications |
| `ecosystem.config.cjs` | PM2 process management config |

---

## [2.1.0] - 2025-03-10

### Added

**Completion Cards** — Zero-bloat response display
- Single self-updating message per session replaces the old 4-message spam (response + diff stat + diff file + notification)
- Card shows: session name header, status icon (idle/permission/continue), time since last activity, 600-char response preview, and diff stat summary
- **Edits in-place** on each new completion — the same Telegram message updates instead of posting new ones
- Utility buttons row: `Full Response` sends the complete output as a `.md` document (or inline `<pre>` if under 3KB), `View Diff` sends the git diff as a `.diff` file (or inline if small)
- Falls back to sending a new card if the old message is too stale to edit

**Auto-Delete Prompts** — Clean chat UX
- When you send a message to Claude, the acknowledgment ("Sent to Claude...") and your original message both auto-delete after 3 seconds
- Keeps the topic clean — only completion cards and command outputs remain visible
- Messages are still accessible in Telegram's chat history if you need to review them

**Smart Reconnect** — Link topics to running panes
- `/reconnect` now works even when there's no existing session mapping (e.g. after a bot restart)
- If no mapping exists, scans all WezTerm panes and shows them as inline buttons to pick from
- Select a pane to link it to the current topic — creates a session and starts polling immediately
- If mapping exists, does the original behavior: re-reads terminal, resets stability, shows current status with action buttons

**Colored Terminal Logs** — Readable bot output
- All console output uses ANSI colors with semantic tags: `[bot]` cyan, `[poll]` blue, `[>>>]` green (outgoing), `[<<<]` magenta (incoming), `[ERR]` red, `[state]` dim, `[live]` yellow
- Startup banner: `━━━ WezBridge V2.1 ━━━` with config summary
- Green checkmark on successful boot: `✓ Bot is running`
- Stability detection spam eliminated — only logs when count actually changes (was flooding 1 line per 3s poll)

### Fixed

**WezTerm Path Detection**
- Multi-environment path resolution: Windows native (`C:/Program Files/WezTerm/wezterm.exe`), Git Bash (`/c/Program Files/...`), WSL (`/mnt/c/Program Files/...`)
- New `findWezterm()` function with `WEZTERM_PATH` env override, candidate list, and `which`/`where` fallback
- Hardened `ensureGui()` — checks mux reachability via `wezterm cli list` before launching, `.on('error')` handler prevents Node crashes, `sleep` fallback for bash environments

**Project Name Resolution**
- `encodePathLikeClaude()` reverse-engineers Claude Code's encoded directory naming scheme (all `:\\/\s_-` characters become `-`)
- `extractProjectRoot()` walks up the decoded path to find the actual project root, not a subfolder cwd
- `resolveProjectPath()` now uses `projectRoot` for correct spawn directory — fixes spawning in `dashboard/react-app` instead of the project root

**Stability & Crash Prevention**
- Global `unhandledRejection` handler prevents bot crashes from stale Telegram callback queries
- Early `answerCallbackQuery` at top of callback handler prevents "query is too old" errors
- `.claude-flow/` added to .gitignore

---

## [2.0.0] - 2025-03-09

### Added

**Live Terminal Streaming**
- `/live` — real-time terminal view updated every 5s in a single Telegram message
- Hash-based change detection (only edits message when content changes)
- Auto-suppresses "thinking" timer and ack messages during live mode

**Project Discovery**
- `/projects` — browse all 38+ Claude projects with inline spawn buttons
- `/sessions <name>` — list sessions with preview, cost, health status
- `/costs` — token/cost summary (today, this week, all-time)
- Auto-discovers projects from `~/.claude/projects/` (no more hardcoded maps)
- Ported scanning logic from [claude-launcher](https://github.com/wolverin0/claude-launcher)

**Code Diffs**
- `diff-extractor.cjs` — git diff stat, unified diff, recent commits
- Automatic diff stat sent after Claude completes changes
- Large diffs sent as `.diff` document attachments

**Permission Handling**
- Detects `y/n` prompts and numbered selectors (`❯ 1. Yes / 2. No`)
- Dynamic buttons: Yes / Always (!) / No / View Details
- Sends correct terminal sequences per prompt type (Enter vs arrow+Enter)
- `--yolo` flag for `--dangerously-skip-permissions`

**Session Persistence**
- State saved to `.wezbridge-state.json` (auto-save every 30s + on exit)
- Sessions survive bot restarts with full pane validation
- `/reconnect` — re-sync after working directly on PC

**Terminal Tools**
- `/peek` — snapshot of last 60 terminal lines
- `/dump` — full 500-line scrollback as `.md` document
- `/export` — session history as markdown document
- `/history` — last 5 prompt/response pairs
- `/replay` — re-send last Claude response

**Photo/Document Support**
- Send screenshots and photos from Telegram to Claude
- Files downloaded and passed as file paths to the session

**Output Formatting**
- Smart output type detection (diff/error/test-results/json/build/plain)
- HTML `<pre>` blocks with ANSI stripping
- Iterative line trimming for Telegram's 4096 char limit
- Plain-text fallback on HTML parse failure
- Tool usage markers (`●`) preserved with spacing

**Plugin System**
- `plugin-loader.cjs` — auto-discovers plugins from `plugins/` directory
- Plugin context: sendMsg, sessions, wezterm, bot, registerCommand, registerButton, on(event)
- Example plugin template included

**UX Polish**
- Auto-deleting "Sent to Claude" acknowledgment (5s)
- Button cleanup after every click (no stacking)
- Bot ignores its own messages
- Sessions open as tabs in same WezTerm window (not new windows)
- Thinking timer suppressed during `/live` mode

### Changed

- `output-parser.cjs` — rewritten with output type detection and rich formatting
- `session-manager.cjs` — hardened completion detection with 3-layer stability check
- `wezterm.cjs` — removed `--new-window` flag, tabs in same window
- `telegram-bot.cjs` — complete rewrite (~1600 lines, up from ~450)

### Fixed

- 409 Telegram conflict on restart (better process management)
- Blockquote parse errors from HTML splitting
- Permission prompts not detected after button click
- Sessions stuck in "waiting" after approving permissions
- `<pre>` tags breaking during active Claude output
- Empty lines stripped from terminal output (now preserved)

## [1.0.0] - 2025-03-09

### Added

- Initial release
- Telegram forum topic ↔ WezTerm pane mapping
- `/spawn`, `/kill`, `/status`, `/help` commands
- Action buttons: Continue, Run Tests, Commit, Status
- Session seeding (`--seed topicId:paneId:project`)
- Output parsing with Telegram HTML formatting
- Bot watchdog with auto-restart
- Rate limiting for Telegram API
- OpenClaw/ClawTrol integration docs

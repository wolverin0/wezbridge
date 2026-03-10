# Changelog

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

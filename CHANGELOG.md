# Changelog

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

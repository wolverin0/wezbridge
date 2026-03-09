# WezBridge V2 — Roadmap

## Done

### Phase 1: Code Diffs + Rich Output
- [x] `diff-extractor.cjs` — git diff stat, unified diff, recent commits
- [x] `output-parser.cjs` — detectOutputType (diff/error/test/build/json/plain)
- [x] formatDiff, formatTestResults, formatStackTrace
- [x] Expandable blockquotes for long responses (no more truncation)
- [x] Full response sent as `.md` document when >1500 chars
- [x] Git diff sent as Message 2 after Claude's response

### Phase 2: Project Discovery
- [x] `project-scanner.cjs` — ported from claude-launcher.pyw
- [x] Scans `~/.claude/projects/`, decodes encoded paths from JSONL `cwd` field
- [x] `/projects` — browse all 38+ projects with inline spawn buttons
- [x] `/sessions <name>` — list sessions with preview, cost, health
- [x] `/costs` — token/cost summary (today, this week)
- [x] Auto-discover projects (no more hardcoded PROJECT_MAP)

### Phase 3: Dynamic Buttons + Permissions
- [x] `actionKeyboard(promptType)` — different buttons for idle/permission/continuation
- [x] Permission: Yes / Always (!) / No / View Details
- [x] Numbered selector support (`❯ 1. Yes / 2. No`) — sends Enter or arrow+Enter
- [x] `--yolo` flag on `/spawn` for `--dangerously-skip-permissions`

### Phase 4: Session History + Replay
- [x] `completionHistory[]` on each session (20-entry cap)
- [x] `/history` — last 5 prompt/response pairs
- [x] `/replay` — re-send last response
- [x] `/export` — full history as markdown document
- [x] State persistence to `.wezbridge-state.json` (survives restarts)
- [x] Auto-save every 30s + on completion + on SIGINT

### Phase 5: Session Reconnect + Peek
- [x] `/peek` — live terminal scrollback (last 60 lines, formatted)
- [x] `/reconnect` — re-sync after working on PC:
  - Re-reads terminal, sends latest response
  - Resets stability state, resumes polling
  - Shows action buttons if idle, starts thinking timer if working

### Phase 6: Completion Detection (Hardened)
- [x] 3-layer stability check: still-working patterns → compaction → hash stability
- [x] STABILITY_COUNT=2 (6s of stable ❯ before firing)
- [x] STILL_WORKING_PATTERNS (background agents, thinking, choreographing)
- [x] COMPACTION_PATTERNS + 20s cooldown (doesn't false-trigger on auto-compact)
- [x] Permission/continuation prompts fire immediately (no stability wait)

### Phase 7: Plugin System
- [x] `plugin-loader.cjs` — discovers plugins from `plugins/` directory
- [x] Plugin context: sendMsg, sessions, wezterm, bot, registerCommand, registerButton, on(event)
- [x] `plugins/example-plugin.cjs` — template plugin

### Phase 8: Live Terminal Streaming
- [x] `/live` — real-time terminal view updated every 5s in single message
- [x] Hash-based change detection (only edits when content actually changes)
- [x] Auto-suppresses "thinking" timer and ack messages during live mode
- [x] Toggle on/off with repeat `/live` command

### Phase 9: Terminal Tools
- [x] `/dump` — full 500-line scrollback sent as `.md` document
- [x] `/peek` improvements — formatted monospace output

### Phase 10: Photo/Document Support
- [x] Send screenshots and photos from Telegram to Claude
- [x] Downloads via Telegram API, saves to temp, passes path to session

### Phase 11: UX Polish
- [x] Auto-deleting "Sent to Claude" acknowledgment (5s TTL)
- [x] Button cleanup after every click (no stacking)
- [x] Bot ignores its own messages
- [x] Sessions open as tabs in same WezTerm window (not new windows)
- [x] Empty lines preserved in terminal output (not stripped)
- [x] Tool markers (`●`) get proper spacing
- [x] Iterative line trimming for 4096 char limit
- [x] Plain-text fallback on HTML parse failure

---

## In Progress / Polish

### Live Dashboard
- [ ] `/dashboard` — pinned message showing all sessions at a glance
- [ ] Auto-updates every 30s by editing the pinned message (no spam)
- [ ] Status icons: idle/working/error per session
- [ ] Session count, active count, last updated timestamp
- [ ] Auto-create dedicated "Dashboard" topic (or use existing)

### Notification Intelligence
- [ ] Wire `notification-manager.cjs` into completion loop (module exists, not connected)
- [ ] Buffer completions for 5s, group concurrent ones into single message
- [ ] Error priority bypasses buffer (immediate send)
- [ ] `WEZBRIDGE_NOTIFY_LEVEL=all|errors|none` already parsed

### Plugin Command Routing
- [ ] Route `/plugin-command` through bot.onText to plugin handlers
- [ ] Plugin-registered buttons need callback routing

### Dashboard Rate Limiting
- [ ] `editMsg` calls should go through rate limiter's edit tracking

---

## Backlog (Nice to Have)

- [ ] `/spawn` from any topic (not just group root) — auto-create topic
- [ ] Multi-session dashboard with per-project grouping
- [ ] Session auto-naming from first prompt
- [ ] Keyboard shortcuts for common prompts (configurable per project)
- [ ] `/config` command to change poll interval, notify level from Telegram
- [ ] Session timeout warnings (idle for >30m)
- [ ] Cost alerts (session exceeds $X threshold)

## Dropped (Not in V2)

- ~~ClawTrol integration~~ — separate concern, not needed for personal use
- ~~Voice/Audio~~ — requires external STT, low ROI
- ~~Multi-user ACL~~ — personal tool
- ~~Webhook mode~~ — polling works fine locally

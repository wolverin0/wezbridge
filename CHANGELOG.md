# Changelog

All notable changes to wezbridge are documented here. Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [3.4.0] - 2026-05-08

### Session snapshot + restore — crash recovery for the AI pane swarm

When WezTerm crashes (mux dies, OS reboot, manual close), every running pane is lost. Re-spawning each one by hand is tedious because each pane has different launch flags (Claude vs Codex, `--channels`, `--dangerously-skip-permissions`, `--continue`, persona, cwd). v3.4.0 adds automatic snapshotting + a one-command restore.

- **`src/session-snapshot.cjs`** (new library, 25 unit tests) — captures `{ cwd, pid, title, tab_title, cmdline, ai }` for every pane running `claude.exe` or `codex.exe`. Appends batches to `vault/_wezbridge/session-snapshot.jsonl`. Also exports `startWatcher({ listPanes, intervalMs })` and `snapshotOnce(...)`. Filter is intentionally narrow: only AI panes get snapshotted, so random shells / debugging panes / the dashboard daemon itself stay out.
- **`scripts/restore-session.cjs`** (new CLI, 11 unit tests) — reads the latest snapshot batch and re-spawns each entry via `wezterm cli spawn --cwd <cwd> -- <cmdline parts>` with stagger (default 2000ms — keeps the telegram channel-plugin race in check). Flags: `--dry-run`, `--stagger-ms N`, `--filter <regex>`. Exit code 0 if all entries spawned, 1 if any failed.
- **Dashboard daemon integration** — when env var `WEZBRIDGE_SESSION_SNAPSHOT={1|<seconds>}` is set, `dashboard-server.cjs` arms a periodic watcher on boot. Default off; opt-in like the other v3.2 modules.
- **`package.json`** — added `npm run restore-session` script alias.

Total: 232 unit tests (was 196 in v3.3.2; +36 from the new modules + their integration tests).

**Usage after a crash:**
```bash
# 1. Reopen WezTerm (mux comes back, no panes inside)
# 2. From any new wezterm pane:
npm run restore-session
# OR
node scripts/restore-session.cjs --dry-run    # preview first
node scripts/restore-session.cjs --filter wezbridge   # only restore wezbridge-cwd panes
```

**Limitations:**
- Only AI panes (claude.exe / codex.exe) — by design. Non-AI shells aren't restored.
- Requires WezTerm mux to be alive (start a fresh wezterm window first).
- Plugin daemons (telegram channel plugin's bun.exe instances) need to come up cleanly. If the snapshot includes panes with `--channels`, the `--stagger-ms` default of 2000ms gives the channel plugin time to settle between spawns.

## [3.3.2] - 2026-05-08

### Three improvements after the v3.3.1 docs pass

Triggered by user dogfooding the OmniClaude-via-Telegram pattern: inbound DMs were arriving but landing in the wrong pane regardless of which Telegram topic they came from, multiple stale `bun.exe` channel-plugin daemons were racing for updates, and `scripts/omniclaude-forever.sh` only worked from one specific Windows path.

- **`src/telegram-router.cjs`** (new, library-only) — reads `~/.omniclaude/telegram-topics.json` and exposes `routeInbound({ chat_id, message_thread_id })` returning one of `route`, `self`, `unknown_chat`, `unknown_topic`. The OmniClaude pane uses this to decide whether to handle a DM inline or forward it via `mcp__wezbridge__send_prompt` to the matching project's pane. The Telegram channel plugin already attached `message_thread_id` (per the 2026-04-11 server.ts patch); this is the missing consumer. 12 unit tests, 196/196 total still green.
- **`scripts/start-omniclaude-pane.cmd`** (new) — kills any stale `bun.exe` processes whose CommandLine matches `claude-plugins-official/telegram` before launching `claude --channels plugin:telegram@claude-plugins-official --dangerously-skip-permissions --continue`. Fixes the 4-bun race observed during this session where ~75% of inbound DMs were going to ghost daemons from earlier CC sessions.
- **`scripts/omniclaude-forever.sh`** — replaced hardcoded `G:/_OneDrive/...` paths with self-resolved `$(cd "$(dirname "$0")/.." && pwd)`. `OMNI_DIR` is now overridable via env var with a sensible sibling-directory default. Script now works on any clone.
- **`docs/SETUP-omniclaude-telegram.md`** — added pointers to `start-omniclaude-pane.cmd` and a "Routing inbound by topic" section showing how OmniClaude uses `telegram-router.cjs`.

## [3.3.1] - 2026-05-08

### Presentation pass — match the docs to the v3.3.0 reality

A docs-only patch reacting to external review (gpt-5 read of the full gitingest dump). The repo had a credibility gap: README declared "wezbridge MCP daemon" but `CLAUDE.md` three lines below described the abandoned theorchestra v2.7.0 dashboard with orchestrator-worker pane and JSON-tick contract. Same repo, two different products. This release makes the docs honest.

- Rewrote `CLAUDE.md` from scratch to describe the actual v3.3.0 surface: zero-deps MCP server, `:4200` headless daemon, `mcp__wezbridge__*` tool list, A2A protocol rules, env vars, useful endpoints. Removed every reference to the orchestrator-worker pane convention, vault structure for escalations, "v3 gate", and the `THEORCHESTRA_LLM_ADVISOR` flag.
- Restructured README to surface the three-layer model (Core / Optional Telegram / Experimental multi-agent) up front. Each tier is opt-in; the "core" alone is the product story.
- Added a "Not included" section right after the tagline (no cloud orchestration, no hosted dashboard, no autonomous manager, no replacement for Claude Code/Codex). Sets expectations in two lines.
- Adopted a tighter tagline: "MCP bridge for controlling Claude Code / Codex sessions inside WezTerm panes, with optional Telegram remote control and simple text-based A2A messaging."

No code changed. 184/184 tests still pass.

## [3.3.0] - 2026-05-08

### Curation pass — wezbridge becomes its own thing

The repo had been carrying the abandoned theorchestra-v3 attempt (React/Vite + TypeScript backend + browser dashboard) alongside the actual shipping wezbridge MCP. This release rips it out so wezbridge is a focused MCP server and nothing else.

**Removed (~250 files, ~36,000 lines)**
- `src/backend/`, `src/frontend/`, `src/mcp/` — the theorchestra-v3 React/Vite + TypeScript MCP rewrite (32 + 10 + 5 .ts files)
- `scripts/v3-*-gate.ts`, `scripts/v3-phase11-*.ts`, `scripts/v3-*-unit.ts`, `scripts/theorchestra-start.ts`, `scripts/fire-ctx-threshold.ts` (29 tsx-driven phase gates)
- `tests/testpane*` + `tests/testproject-*` (sandbox PRDs for unrelated dogfood projects)
- `debates/002-orchestrator-cycle-stop/` (debate process artifacts)
- `handoffs/` (session-local handoff files)
- `docs/_archive/`, `docs/adrs/v3.0-*`, `docs/features/*`, `docs/screenshots/v3.0/`, `docs/screenshots/tests/`, `docs/soak-reports/`, `docs/PLAN-OF-TRUTH.md`, `docs/architecture.md`, `docs/futureroadmap.md`, `docs/v3.0-*.md`, `docs/SESSION-HANDOFF-*`, `docs/ROLLBACK-*` (theorchestra-v3 documentation tree, ~103 files)
- `tsconfig.json`, `package-lock.json` (no longer needed — zero npm deps)

**Repackaged**
- `package.json`: name `theorchestra` → `wezbridge`, version `3.2.1` → `3.3.0`, description rewritten, all v3:* npm scripts removed, `dependencies: {}` (was 12 packages), `devDependencies: {}` (was 12 packages). wezbridge .cjs core uses only Node built-ins.
- `README.md`: rewritten to lead with the wezbridge value prop (multi-pane MCP + OmniClaude-via-Telegram pattern). Old roadmap and "install via agent" sections dropped. Pointer to `docs/SETUP-omniclaude-telegram.md` for the daily-driver pattern.

**Preserved**
- `omniclaude-pre-rollback` git tag at commit `acd3460` — frozen pre-revert state for anyone wanting to revive the dashboard / orchestra-goose ambition.
- `legacy-v2-bot` branch — original v2.x Telegram bot history.

**Verified**
- 184/184 unit tests still pass.
- `mcp__wezbridge__*` tool surface unchanged.

## [2.5.0] - 2026-04-16

### Agency Mode — multi-persona orchestrated teams

The headline feature: drop a PRD → orchestrator spawns a team of persona-specialized Claude agents, each in their own worktree, coordinating via A2A. 5 phases shipped in a single session.

**Phase 1 — Persona injection** (commits 7e3197d, 6a19800, bbe696d)
- `POST /api/spawn` accepts `{persona, permission_mode}` → builds `claude --append-system-prompt-file <persona.md>` command
- `GET /api/personas` → 95 personas from `~/.claude/agents/` with YAML frontmatter metadata
- `spawn_session` MCP tool extended with same params
- `discoverPanes()` detects persona from WezTerm `tab_title` field (set via `setTabTitle`)
- 3 bugs found during live E2E: title vs tab_title confusion, shell args vs claude args, --continue resume conflict

**Phase 2 — Dashboard persona UI** (commit e6de964)
- Persona dropdown in Spawn view (grouped by category via `<optgroup>`)
- Permission mode selector (bypass/plan/acceptEdits/default)
- Persona badges on pane cards in Sessions sidebar + Desktop windows

**Phase 3 — Git worktree isolation** (commit e6de964)
- `POST /api/spawn {worktree: true}` → creates `.worktrees/<persona>-<id>` + branch `claude/agency-<persona>-<id>`
- `GET /api/worktrees` — list active worktrees
- `POST /api/worktrees/:paneId/merge` — merge branch to main
- `POST /api/worktrees/:paneId/cleanup` — remove worktree + branch
- Auto-cleanup on pane kill

**Phase 4 — PRD-driven team bootstrap** (commit 14d7dc2)
- `docs/prd/<name>.md` schema with YAML frontmatter roles array
- `POST /api/agency/bootstrap {prd}` → reads PRD, spawns each role (3s stagger), sends A2A handoff with task, tracks in teamsRegistry
- `GET /api/agency/teams` — active teams with live pane statuses
- `GET /api/agency/prds` — list available PRDs
- `spawn_team` orchestrator action (always escalates)

**Phase 5 — Agency tree view** (commit 14d7dc2)
- Agency Teams section in Spawn view with PRD cards + Bootstrap button
- Live tree: team header → role rows with persona badge + status dot + branch + task
- Merge/Cleanup action buttons per worktree
- Team completion banner with Merge All
- Auto-refresh 15s while Spawn tab active

**Live E2E verified**: bootstrapped example-test PRD → reviewer (pane-29) + tester (pane-30) spawned with personas, both showed WORKING in dashboard tree view, persona badges visible in sidebar.

### Also in this release

- CLAUDE.md refreshed to v2.5 with Agency Mode docs
- 25 legacy files archived to tmp/legacy-src/
- Reviewer persona pane found 5 real documentation issues (actioned same session)

## [2.4.4] - 2026-04-15

### Fix status detection — Unicode ellipsis + "esc to interrupt" (T-060)

Bug reported by user: working panes show as `idle` on the dashboard. Root cause in `src/pane-discovery.cjs` `STATUS_PATTERNS.working` — regex literals like `/\bThinking\.\.\./` require three LITERAL dots (`...`), but modern Claude Code renders `Thinking…` using the Unicode ellipsis character `…` (U+2026). The working check silently fails, the if-elseif chain falls through to `idle` which matches the persistent `❯` prompt still in scrollback → pane reported idle despite being visibly active.

### Fix

- Add `/esc to interrupt/i` — the most reliable signal, shown ONLY during active tool execution. Zero false positives when a pane is actually idle.
- Add a generalized catch-all `/\b[A-Z][a-z\u00E0-\u00FF]{2,}(ing|ed)\s*(\u2026|\.{3})/` for verb + ellipsis OR three-dots, covering Thinking, Reading, Writing, Editing, Searching, Running, Creating, Analyzing, Implementing, Planning, Cooking, Brewing, Ingesting, Computing, Compiling, Deploying, Sautéing, Sautéed, etc.
- Keep the original braille spinner regex (still valid) and the `●.*agent` indicator.
- Remove the old dot-only verb patterns (redundant with the unified catch-all that accepts both `…` and `...`).

### Verified

After restart, pane-10 (wezbridge itself, executing MCP tools during this session) correctly shows `working` where before it showed `idle`. 18/18 smoke tests still pass.

## [2.4.3] - 2026-04-15

### Mobile sessions UX — 2×3 grid + slim spawn button (T-059)

User mockup via Telegram: replace the cramped horizontal pill bar with a denser grid that shows more sessions at once and moves the bulky in-list "+ Spawn Session" block to a slim full-width button below.

- `#sidebarList` on `@media (max-width: 768px)` becomes a CSS Grid:
  `grid-auto-flow: column`, `grid-template-rows: repeat(3, minmax(44px, 1fr))`, `grid-auto-columns: calc(50% - 3px)` — 6 sessions visible per page (3 rows × 2 cols), horizontal scroll-snap with `scroll-snap-align: start` on every 6th item to land on full pages.
- `.sidebar .sidebar-spawn` (the dashed full-height block, awkward on mobile) hidden via `display: none` on mobile.
- New `#mobileSpawnBtn` rendered right after the `.sidebar` div: full-width minus 16px gutters, 44px tall, gradient accent background, hidden on desktop via `@media (min-width: 769px)`.
- Item content density tuned: 12px name font, 9px pane id, 10px border-radius, 44px min-height (touch).
- Slim 4px scrollbar on the grid for visual hint of scrollability.

Verified at 390×844 (iPhone): 7 panes render as a 2×2-and-half scrollable grid, scrolling reveals the 7th, slim spawn button below at 359×44px, legacy in-grid spawn block hidden. Desktop @ 1400×900: list back to default block layout, legacy spawn visible, mobile button hidden. 18/18 smoke tests still pass.

## [2.4.2] - 2026-04-15

### Mobile hotfix — legacy notification blocked session bar

Bug reported: "Elduderino [app pane] figura como working y no puedo hacer nada en omniclaude mobile" (T-058). Two notification systems were firing simultaneously on the same events:

1. **Legacy `.feed-notification`** (v3.1) at `position: fixed; top: 44px; right: 20px; max-width: 360px` with no `pointer-events` control.
2. **v2.3 `#toastStack`** (newer, with `pointer-events: none` on container + `all` on children).

On the mobile layout the sessions pill bar lives around y=36-86px. The legacy notification sits RIGHT ON TOP of it, 360px wide on a 390px viewport = basically full-width — taps to switch sessions (including to omniclaude) landed on the invisible notification's `cursor:pointer` handler instead of the session pill behind it. 8s auto-dismiss meant the block lasted 8s every time a pane completed or needed permission.

### Fix

`@media (max-width: 768px)`:
- `.feed-notification { display: none !important }` — hide the legacy system on mobile (redundant with `#toastStack`)
- `#toastStack`: reposition to bottom of viewport (`bottom: 76px`, above the nav), full-width with 8px gutters, `max-height: 40vh overflow-y: auto`, preserves `pointer-events: none` on container
- `.notif-stack { display: none !important }` — belt-and-suspenders hide of the Desktop-view notif overlay system (already hidden because Desktop view is blocked on touch, but explicit)

Verified via Playwright @ 390×844: session pill bar no longer overlapped when a notification is active, 18/18 smoke tests still pass.

## [2.4.1] - 2026-04-15

### Mobile responsive + LAN access

Shipped after a brief `dog-food` window when the user accessed the dashboard from a phone and found it usable but cramped. Promoted from `futureroadmap.md` `v2.6+` to shipped, delivered via A2A task T-026.

**Security / LAN access (commit 22a9d14)**
- CSRF allowlist auto-detects local network interfaces at boot via `os.networkInterfaces()`. localhost + 127.0.0.1 + [::1] + every non-internal IPv4/IPv6 address on PORT. Logged on startup. DHCP rotation requires dashboard restart.
- Phones/tablets/other devices on the LAN can now hit the dashboard AND make POST actions (kill/spawn/handoff/broadcast) — previously same-origin check only allowed localhost.

**Mobile UX Nivel 1 (commit bdb0054)**
- Viewport meta already present.
- `@media (max-width: 768px)` baseline: topbar tighter + horizontally scrollable tab overflow; sessions sidebar flipped to horizontal-scroll pill bar at top of Sessions view; activity sidebar becomes a right-side slide-in drawer (`translateX` with backdrop overlay); tasks strip auto-collapsed with tap-to-expand (bottom-sheet feel); pane cards full-width stacked; spawn project grid single column; Desktop view replaced by a "needs mouse" message on touch devices; modals full-screen; handoff dropdown anchored as bottom action sheet.
- 44×44 touch targets on sidebar items, buttons, action controls.
- New `#mobileSidebarToggle` (☰) button + `#mobileSidebarBackdrop` wired in the topbar; hamburger replaces the chevron on mobile.
- New `isMobile()` / `toggleMobileSidebar()` / `applyMobileDefaults()` JS helpers. Tap-anywhere-on-tasks-strip toggles expand. Resize listener cleans up mobile overlay state when crossing breakpoint back to desktop.

**Mobile UX Nivel 2 (commit d364d67)**
- Bottom navigation bar (`#bottomNav`, 64px) fixed at viewport bottom on mobile: 4 tabs (Sessions/Live/Desktop/Spawn) with icon + label, accent color for active, glass-blur background. `body { padding-bottom: 64px }` pushes content up. Tasks strip and activity drawer bottom offsets adjusted to 64px so they stack above the nav.
- Swipe-from-right-edge opens the activity drawer: document-level touchstart/move/end listeners, triggers when gesture starts ≤24px from right edge AND travels ≥50px leftward with horizontal dominance (dx > dy × 1.5). Swipe-right inside the open drawer closes.
- `#swipeEdgeHint` thin 8px strip on the right edge for discoverability (tap also opens the drawer).
- `syncBottomNav(view)` updates active state; wraps `window.switchView` as a side-effect without breaking its signature.
- `@media (min-width: 769px)`: bottom nav + swipe hint hidden. Zero desktop regression, verified at 1400×900.

### Tests

- 18/18 smoke tests still pass (added one: LAN origin from machine's own interfaces passes CSRF gate).

### Verified via Playwright at 390×844 (iPhone 13 Pro viewport)

- Activity drawer slides in on ☰ tap with backdrop; swipe from right edge opens
- Bottom nav active tab syncs with view, all 4 tabs switch correctly
- Tasks strip starts collapsed, taps expand to 40vh bottom sheet
- Resize to desktop clears all mobile overlay state cleanly

## [2.4.0] - 2026-04-14

### Pivot to HTML dashboard + A2A handoff protocol

After v2.1 the React dashboard was abandoned. v2.2 consolidation was superseded. v2.3 ships the v3.1-aesthetic **HTML dashboard** served from `src/dashboard.html` on :4200 as the canonical frontend.

**v2.3 (commit 1f31259) — compact activity sidebar + handoff UI**

- Right `#activitySidebar` 260px collapsible, 3 stacked panels: OmniClaude monitor (auto-detect pane, 3s refresh), A2A activity (live SSE + `/api/a2a/pending` snapshot), compact Events (one-liner + click-to-expand, filter chips). Replaces the legacy Live Feed that ate 1/3 of screen.
- Bottom tasks strip 180/32px collapsible with status-colored pills.
- A2A badges on pane cards (direction-aware).
- Orphan toasts (slide-in top-right, 30s dedup).
- Handoff UI: `↗ Handoff` + `📜 History` buttons on every pane card.
- Backend: `GET /api/a2a/pending` (LRU 500 + 24h TTL), SSE translation layer mapping watcher events to v3.1 contract, `POST /api/a2a/handoff`.

**v2.3.1 (commit e5c0583) — handoff redesign**

- Reversed the handoff flow: the backend does NOT write files or touch the target pane. Instead it sends an **instructive prompt to the SOURCE pane** which authors its own handoff file in its own project's `handoffs/` folder (unique filename, never overwrites) and contacts the target via `mcp__wezbridge__send_prompt` + `send_key('enter')`. Source pane has richest context → author-quality handoffs; every A2A envelope on the wire originates from a legitimate MCP call.
- UI updated: removed prefilled summary, renamed optional field to "Extra context for <source>", button says "Send to <source>".

**v2.4 (commit 7ef5069) — drag-reorder + arrows + handoff scan + Routines scaffolding**

- Panel drag-to-reorder in right sidebar with localStorage persistence.
- A2A arrows SVG overlay on Desktop view (pointer-events:none, quadratic Bezier curves between active corr pane pairs, 3 markers color-coded active/resolved/orphaned, orphan pulsing, 10s fade for resolved).
- Handoff history filesystem cold-start scan: `GET /api/handoffs?pane=N` scans `<cwd>/handoffs/*.md` + parses header metadata; modal merges with in-memory history.
- Claude Routines integration scaffolding: `src/routines-config.cjs` loader (YAML fenced blocks in `vault/_routines-config.md`, 30s cache), `vault/_routines-config.md.template` skeleton, `POST /api/routines/fire` proxy to `api.anthropic.com/v1/claude_code/routines/:id/fire` with `experimental-cc-routine-2026-04-01` beta header, `fire_routine` action in orchestrator-executor (always escalates, user-gated).
- React dashboard archived to `tmp/dashboard-react-v2.1/` (gitignored).
- CLAUDE.md refreshed to describe current surface.

**v2.4 stabilization (commit 3a9c5ca) — CSRF defense**

- All POST endpoints now check the `Origin` header. Same-origin (`http://localhost:4200` / `127.0.0.1:4200`) passes; no-Origin (curl/CLI) passes; cross-origin (evil.com) → 403. GETs unaffected.
- Closes an open attack vector where a malicious webpage opened in the user's browser could kill panes, inject prompts, or exfiltrate handoffs via zero-auth localhost endpoints.

### Breaking

- `/api/panes/:id/output` now returns `{pane_id, output, lines}` (both fields) — v3.1 HTML reads `data.output`, so if anyone relied on reading only `data.lines`, both are present.
- `POST /api/a2a/handoff` body changed: `{source_pane, target_pane, instruction, context?}` — v2.3's `summary` field renamed to `context` (optional). Old clients sending `summary` still work via fallback.

### Infra

- Branch consolidation: all legacy branches (clawfleet/*, theorchestra/dashboard-v2.0/v2.1/v2.2, a2a/*) deleted local+remote. Single `main` branch on `github.com/wolverin0/theorchestra` (canonical). `github.com/wolverin0/wezbridge` preserved as `wezbridge-legacy` remote for historical reference.

### Docs

- `docs/PLAN-dashboard-v2.3.md`, `docs/PLAN-dashboard-v2.4-cleanup.md` — ship-plans (closed).
- `docs/futureroadmap.md` — v2.5 Agency Mode + v2.6+ backlog (not started; gated by v2.4 dog-food week).


## [2.1.0] - 2026-04-14

### Major — v3.1 visual port + A2A arrows + toasts + sounds

After v2.0 user feedback ("es un asco" vs the v3.1 ancestor), a full aesthetic port of the v3.1 `.dwin` terminal pattern into our React architecture — plus brand-new features v3.1 never had.

**Ported from v3.1 verbatim**:

- Mac-style traffic lights (red/yellow/green circles) on every Desktop window header, with red=kill, yellow=minimize.
- Terminal-card aesthetic: soft gradient header, centered project title, dark terminal body (`#05080d`), thin custom scrollbar, rounded corners, soft drop shadow.
- **Inline prompt bar per window**: `<input placeholder="Prompt...">` + Send + Q+ + Ctx + Mode — type directly in the window, hit Enter, NO modal round-trip. This replaces the `window.prompt()` + modal flow in Desktop mode. Q+ tags the prompt as `[queued]`, Ctx sends a context ping, Mode cycles pane mode via `/mode`.
- **Layout buttons**: Tile (sqrt(n) grid), Cascade (28px stagger), Stack (all centered), Show All (restores minimized).
- **Broadcast input** in the desktop toolbar: one-shot send to every visible Claude pane.
- **Dock bar redesigned**: 44px circular avatars with 2-letter project initials + pulsing status dot (green=idle, blue=working, yellow=permission). Glass-blur floating pill bottom-center of desktop.

**Brand-new (no v3.1 equivalent)**:

- **A2A arrows overlay**: curved SVG arrows drawn from pane-N to pane-M for every in-flight or recent A2A `corr`, derived PURELY from the SSE event stream (no backend change needed). Blue=open, green=resolved, red=orphaned. Dashed when resolved/errored, solid when in-flight. Labels show `corr·type`. Re-renders on resize + every 2s for layout drift.
- **Toasts** (top-right stack): `session_completed` (✅), `session_permission` (🔐), `peer_orphaned` (⚠️). Auto-dismiss 6s, manually closeable.
- **Sounds**: WebAudio-synthesized beeps — 880→1320Hz fanfare on completed, 660Hz on permission, 440Hz on orphaned. No audio assets shipped. Respects browser autoplay policies.

### Bundle

213.93KB JS (+10KB vs v2.0 for A2A arrows + toasts + sounds), 14.83KB CSS. Zero TypeScript errors. E2E-validated via Playwright before commit per the "no syntax-only ship" rule (claim 9393).

### Still on roadmap (v2.2+)

- Sessions sidebar view (per v3.1 screenshots: click pane → big terminal on right).
- Spawn view with project grid (per v3.1 screenshots).
- Active Tasks collapsible drawer.
- Monitoring section showing what OmniClaude is watching.
- OmniClaude pinned window (always visible).
- Replace react-rnd with custom hook.
- Cmd+K command palette.

## [2.0.0] - 2026-04-14

### Major — Dashboard v2.0 (windowing + PromptComposer + permission buttons)

User feedback on v1.1 dashboard: "altamente inferior" to the v3.1 ancestor which had drag/resize windows. This release recovers the v3.1 UX bar — **adapted to the agent-centric architecture** — plus new features v3.1 never had.

- **Desktop view** (new tab alongside Grid) — free-form windowed layout via `react-rnd`. Drag by pane header, resize via edges/corners, minimize to bottom dock, focus-to-top on click. Layout persists per-pane to `localStorage[theorchestra:desktop-layout:v2]` with schema-versioned key + parse-failure fallback.
- **DockBar** — bottom taskbar for minimized windows. Click to restore. Shows project name + status dot.
- **PromptComposer** — modal replacement for `window.prompt()`. Multiline `<textarea>`, `Ctrl+Enter` submits, `Escape` cancels, last-5 prompts history dropdown (per-user localStorage), **broadcast mode** (checkbox list when ≥2 panes selected in Grid view → sends prompt to all in parallel via `Promise.allSettled`, per-target errors don't block siblings).
- **Permission inline buttons** — when a pane enters `status: 'permission'`, its action row auto-swaps to `[✅ Approve] [✅✅ Always] [❌ Reject]`, wired to `POST /api/panes/:id/key` with `1`/`2`/`3`. Debounced 500ms per-pane against double-clicks.
- **View tabs** — `Grid` / `Desktop` / `Events` / `Tasks` at the top; active tab persists to localStorage. Events and Tasks now have full-width views in addition to the sidebar/bottom rails.
- **Selection + Broadcast** — checkbox on each Grid card, "📢 Broadcast to N" appears in header when ≥1 selected.
- **New hooks**: `useLocalStorage` (versioned keys + cross-tab sync), `useZStack` (z-index management for Desktop since react-rnd doesn't ship one).
- **Codex identity detection** — `PaneCard` now scans the output for `gpt-` prefix in addition to title, so Codex panes show `codex` badge.

### Verified E2E

All previously-committed-but-untested pattern REJECTED — per the rule in claim 9393: npm run build + Playwright smoke is now non-optional pre-push. Dashboard v2.0 was validated via claude-in-chrome Playwright MCP with every interaction tested (drag, resize, minimize, restore, select, broadcast, tab switch, localStorage persistence) before this commit. Zero console errors from our code.

### Dependencies

- Added `react-rnd@^10.4.13` (~18KB gzip). Known React 18 StrictMode `findDOMNode` warning — only emits in dev builds, not our production bundle. Replacement with custom `useDraggableResizable` hook tracked for v2.1.

### Out of scope (next releases)

- **v2.0.1**: A2A panel (`GET /api/a2a/pending` + client-side SSE accumulation showing pane-to-pane corr timeline) + maximize-to-modal with full scrollback + Tile/Cascade/Stack layout buttons.
- **v2.1**: replace react-rnd with custom hook, Cmd+K command palette, dark/light theme toggle, MemoryMaster claims feed, pane-to-pane graph view.

## [1.5.1] - 2026-04-14

### Renamed — `clawfleet` → `theorchestra`

The project rebranded from `clawfleet` to `theorchestra`. GitHub repo renamed via `gh repo rename` (old URL `wolverin0/clawfleet` redirects to `wolverin0/theorchestra` automatically). Local folder remains at `wezbridge/` for process path stability (per the original folder-rename constraint). MCP namespace remains `wezbridge` (per the same compatibility constraint — existing Claude Code sessions registered the MCP under `wezbridge` and we don't break them).

Mass replacement: 126 string refs across 33 files (all docs, code, config — `clawfleet` → `theorchestra` with capitalization preserved). PM2 app names changed (`clawfleet-streamer` → `theorchestra-streamer`, `clawfleet-dashboard` → `theorchestra-dashboard`); update your `pm2 start ecosystem.config.cjs` invocation if you'd already deployed. `theorchestra-media/` and `theorchestra-voice/` are the new tmpdir cache paths.

## [1.5.0] - 2026-04-14

### Added — big feature landing: voice + media + plugins + webhooks

- **`src/voice-handler.cjs`** — OpenAI-compatible Whisper transcription. `downloadTelegramVoice(fileId, botToken)` + `transcribe(path, {language, model, endpoint})`. Zero-dep: pure Node stdlib `https` + manual multipart builder (no `openai` SDK, no `form-data` package). Endpoint overridable for self-hosted Whisper / Groq. Env: `WHISPER_API_KEY`, `WHISPER_ENDPOINT`, `WHISPER_MODEL`, `WHISPER_LANGUAGE`.
- **`src/media-handler.cjs`** — Telegram photo/document/video/audio/voice → local paths on `os.tmpdir()/theorchestra-media/`. `downloadMessageMedia(msg, botToken)` + `formatPromptPreamble({paths, caption})`. Stable file_id-based filenames (idempotent, no re-downloads). Claude Code's `Read` tool / Codex equivalents open the files directly — no base64, no image processing, no third-party upload.
- **`src/plugin-host.cjs`** + **`plugins/`** — drop-in replacement for `node src/omni-watcher.cjs` in Monitor configs. Loads `plugins/<name>/index.cjs` (or `.cjs` files at the plugins root), dispatches watcher events to `{name, register(ctx)}` modules. Context is deliberately narrow: `wezterm` + `on/emit/log` + `readOutput` — NO bot, NO pane mutation, NO secrets. Plugins observe and emit; OmniClaude decides. Ships with `plugins/example/` (hello-world) + full API ref at `docs/plugins.md`.
- **`src/github-webhook.cjs`** — HTTP receiver for GitHub webhooks. Verifies `X-Hub-Signature-256` HMAC (timing-safe). Formats `push`, `pull_request`, `issues`, `release`, `workflow_run` events into Telegram-ready HTML chunks. Emits theorchestra events (`source: 'github'`) on stdout — same JSON-per-line pattern as the watcher. Standalone or mountable on an existing http server via `handleRequest(req, res)`.

### Documented

- `docs/features/voice-prompts.md`, `docs/features/media-forwarding.md`, `docs/features/github-webhooks.md`, `docs/plugins.md`, `plugins/README.md`, `plugins/example/README.md`.

### Architectural rigor

Every new module in this release honors the agent-centric boundary: the observation layer (watchers, plugins, receivers, helpers) cannot post to Telegram, cannot mutate panes, cannot access secrets. OmniClaude — a real Claude Code session — is the single decision point. See claim 9289 for the rule.

### Still pending

- **Inline mode** (`@theorchestra_bot`) — blocked on an upstream Telegram channel plugin patch for `callback_query` / `inline_query` forwarding. Not theorchestra-side work.

## [1.4.0] - 2026-04-14

### Added — Telegram UX helpers

- **`src/permission-alerts.cjs`** — `formatPermissionAlert({paneId, projectName, promptPreview})` renders a Telegram-ready HTML block asking the user to reply `/approve`, `/always`, or `/reject`. `parsePermissionCommand(text)` maps the reply back to a `send_key` payload (`1`, `2`, `3`). Text-command flow because the Telegram channel plugin owns `getUpdates` — inline buttons gated on an upstream plugin patch (deferred to Phase 4).
- **`src/project-scanner.cjs`** — enumerates every Claude Code project under `~/.claude/projects/` AND every Codex CLI session under `~/.codex/sessions/`. Resolves the real cwd by reading the newest JSONL's `cwd` field (30 KB tail read, safe on multi-GB logs). Returns `{ agent: 'claude'|'codex', realPath, name, sessionCount, latestSessionUuid, latestActivityMs }`. CLI mode: `node src/project-scanner.cjs [--json] [--no-codex] [--limit N]`.

### Documented

- `docs/features/permission-commands.md` — end-to-end flow, OmniClaude Event Reaction Tree entry, security note (anyone in the Telegram group can approve).
- `docs/features/project-scanner.md` — OmniClaude `/projects` and `/spawn <name>` command handlers, performance notes.

### Cross-LLM

Project scanner is the first theorchestra module to deliberately index BOTH Claude and Codex sessions — previously every cross-LLM affordance was runtime (spawning Codex panes from Claude). With this, `/projects` can spawn either agent for any project by friendly name.

## [1.3.0] - 2026-04-14

### Added — ops & observability

- **`src/diff-reporter.cjs`** — compact post-session-completed git-stat summary. Returns `{ summary, files, top, html, plain, branch, clean }` or `null` when there are no tracked changes. Designed for OmniClaude to post "what just changed?" to the pane's Telegram topic after a `session_completed` event. CLI mode: `node src/diff-reporter.cjs [cwd] [--json]`. Read-only.
- **`src/ntfy-notifier.cjs`** — [ntfy.sh](https://ntfy.sh) backup push notification channel. `isEnabled()` returns false when `NTFY_TOPIC` is unset so callers can always-call. Supports public ntfy.sh + self-hosted + token-authenticated instances. 80 LOC, Node stdlib only.
- **`ecosystem.config.cjs`** — PM2 production supervisor config. Two apps: `theorchestra-streamer` (telegram-streamer.cjs) + `theorchestra-dashboard` (dashboard-server.cjs). Watcher stays under OmniClaude's Monitor tool by default (commented config template included).

### Documented

- `docs/features/diff-reporter.md` — OmniClaude Event Reaction Tree integration + rate-limit/filter heuristics (skip trivial edits).
- `docs/features/ntfy-and-pm2.md` — ntfy setup (public / self-hosted / authenticated), PM2 commands, rationale for keeping OmniClaude itself outside PM2.

### Env vars

- `NTFY_TOPIC` (enables ntfy), `NTFY_SERVER` (default `https://ntfy.sh`), `NTFY_TOKEN` (optional bearer).

## [1.2.0] - 2026-04-14

### Added — new wezbridge MCP tools (6)

- **`split_pane(pane_id, direction?, cwd?, program?, args?)`** — side-by-side or top/bottom split without auto-launching Claude. Opens a shell / Codex / any program next to an existing session.
- **`set_tab_title(pane_id, title)`** — live rename a WezTerm tab. Best practice for multi-pane projects: `<project>-<agent>` (e.g. `app-codex`, `app-claude`).
- **`spawn_ssh_domain(domain, cwd?, program?, args?)`** — spawn a pane on a pre-configured WezTerm SSH domain. Run remote Claude/Codex sessions that local OmniClaude can still `send_prompt` / `read_output` / `kill_session` through.
- **`list_workspaces`** — enumerate WezTerm workspaces and the panes in each.
- **`switch_workspace(name)`** — activate a workspace (creates if missing).
- **`spawn_in_workspace(workspace, cwd?, program?, args?)`** — create a new pane directly in a named workspace. Useful for grouping peer panes by project.

### Documented

- `docs/features/split-workspace-remote.md` — `/split`, `/rename`, `/remote` Telegram command handlers for OmniClaude, plus recommended worktree flow for multi-pane peer projects on shared repos.
- `docs/features/workspaces.md` — `/workspace` command, WezTerm version compatibility caveats, when-to-use `workspaces` vs `split_pane`.

### Compatibility

- Running Claude Code sessions must reload the `wezbridge` MCP server to see the new tools.
- Some older WezTerm versions may not support all workspace operations — `list_workspaces` is widely supported, `switch_workspace` / `spawn_in_workspace` need recent WezTerm.

## [1.1.0] - 2026-04-14

### Added

- **Desktop dashboard** (Vite + React + TypeScript strict) — pane grid view, live SSE event stream from `omni-watcher.cjs`, active_tasks panel, action buttons (Prompt / Enter / Y / Kill).
- **`src/dashboard-server.cjs`** — ~200 LOC Node-stdlib HTTP + SSE backend. Endpoints: `GET /api/panes`, `GET /api/panes/:id/output`, `GET /api/tasks`, `GET /api/events` (SSE), `POST /api/panes/:id/prompt|key|kill`, `POST /api/spawn`. Also serves the built SPA from `dashboard/dist/`.
- **`dashboard/`** — Vite + React app. Dev: `npm run dev` proxies `/api` to `:4200`. Prod: `npm run build` emits `dashboard/dist/` which the backend serves directly.
- Dark terminal-native theme, snake_case pane shape matching wezbridge MCP contract.

### Not yet in this release
- A2A pending-corr panel (needs watcher-side state export)
- Claims feed (MemoryMaster MCP integration)
- Permission-prompt inline approve/reject buttons (upstream plugin patch required)
- Auth (assumes localhost-only)

## [1.0.0] - 2026-04-14

Initial public release as `theorchestra`. Forked in spirit (not in history) from [wolverin0/wezbridge v3.1](https://github.com/wolverin0/wezbridge) — substrate shared, coordination philosophy replaced.

### Agent-centric orchestration

- **OmniClaude orchestrator** — a persistent Claude Code session is the coordinator, not a Node bot. It discovers panes, watches events, reacts to Telegram, and dispatches A2A messages to peers.
- **Peer-to-peer A2A protocol** — any Claude/Codex pane can send a structured envelope to any other pane via `wezbridge` MCP. Envelopes are `corr`-threaded and carry `request` | `ack` | `progress` | `result` | `error` semantics.
- **Push-vs-watch asymmetry** — responders MUST push `type=progress` every ~3 min and `type=result` on completion (because Codex has no `Monitor` tool, so responders can't assume the requester is watching).
- **Three orchestration layers** — subagent (in-process) vs peer pane same-project vs peer pane cross-project. Agents reading the global instruction files know when to pick which.

### Crash detection & resilience

- **`peer_orphaned` events** — `omni-watcher.cjs` parses A2A envelopes in pane output, tracks pending exchanges by `corr`, and emits a P1 event when a pane dies with unresolved A2A. OmniClaude consumes the event and notifies the surviving peer.
- **`session_stuck` detection** — activity-based hashing of pane output distinguishes "working but silent" from "truly stuck". Configurable threshold.
- **Graceful watcher re-launch** — monitors emit `relaunch_me` at the 55-min mark so OmniClaude re-spawns them before the Monitor-tool 1h hard timeout.

### Telegram live feed

- **One editable message per pane per topic** — `editMessageText` keeps a single live tail in view; doesn't spam the topic with new messages.
- **Auto-topic creation** — new projects get their own forum topic the first time a pane appears there (via `createForumTopic`). Persisted to `~/.omniclaude/telegram-topics.json`.
- **Dense view** — chrome stripping removes status bar, `Ctx:`, spinner lines, box-drawing, ceremonial tool-call acks; long ⎿ tool-result blocks (>3 lines) collapse to a one-line summary + preview. The 40-line live window survives long `ingest_claim` or `query_memory` outputs.
- **Pane identity header** — `[project · agent-model]` (e.g. `[memorymaster · claude-opus]`), disambiguated to `[project-agent · model]` when ≥2 panes share the same project (e.g. `[app-codex · gpt5]` vs `[app-claude · opus]`).
- **User-supplied pane aliases** — `~/.omniclaude/pane-aliases.json` overrides auto-detection, hot-reloaded.

### Active tasks durability

- **`active_tasks.md`** is the single source of truth for in-flight work. Format: `## T-NNN · Title` + fenced YAML block per task.
- **`tasks-watcher.cjs`** emits `task_added`, `task_status_changed`, `task_stuck`, `followups_pending`, `tasks_file_updated`.
- **Contract**: no task without an entry, report = close, read before reply, signals are priority.

### Safety rails

- **`scripts/commit-guard.js`** — PreToolUse hook + git pre-commit hook. Blocks on `main`: ≥4 staged files, infra files (`.env`, `package.json`, docker*, nginx*, *.yml, …), new files, destructive flags (`--no-verify`, `reset --hard`, `push --force`, `rm -rf`, `drop`), cross-module commits. Any non-`main` branch allows everything.
- **No hardcoded secrets** — env-var-only.
- **No silent file corruption** — shared-repo safety recommends `git worktree add` for multi-pane projects and `| owns=<subdir>/` envelope declaration as fallback.

### Known limits (deferred, not blockers)

- **Heartbeat enforcement** — rule exists, no watcher-side silent-peer flag yet.
- **Envelope validation** — malformed envelopes are ignored silently rather than surfaced to the sender.
- **Worktree init script** — shared-repo worktree is recommended, not scripted.
- **Dashboard** — no desktop UI yet (Phase 2).
- **v3.1 features** — permission buttons, voice prompts, project scanner, plugins, /split/workspace/remote, code diffs, GitHub webhooks, PM2, inline mode, ntfy — all on the Phase 3 roadmap.

### Compatibility note

The MCP namespace is **`wezbridge`** (not `theorchestra`) to match the tool name agents call (`mcp__wezbridge__*`). The project is called theorchestra; the MCP tool stays `wezbridge` for backward compatibility with any existing Claude Code sessions that already have it registered.

---

## Pre-v1.0

Pre-rebrand iteration happened in `wolverin0/wezbridge` (v1–v3.1). That repo remains as the historical artifact of the bot-centric architecture and is not part of this changelog.

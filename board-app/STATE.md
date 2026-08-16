<!-- doc-head: T-0140 fleet board app STATE - design decisions, spec deviations, ops runbook.
Covers: React/Vite PWA cockpit in board-app/, bare-node server.cjs :4272, ruling verb mapping,
token-or-loopback bind, Task Scheduler hosting (wezbridge-fleet-board), PWA/LAN limits,
Playwright walk scripts. Read when: operating the board, auditing T-0140, changing the API. -->

# Fleet Board App — STATE (T-0140)

Built 2026-08-16 by pane-47 against `.orchestrator/FLEET-BOARD-APP-SPEC.md`. This file records
every decision and deviation the spec requires justified.

## Design decisions (skills invoked pre-code: taste-skill, impeccable, frontendgame, emil-design-eng, ui-ux-pro-max)

- **Dark-only, committed.** Scene: the operator glances at decisions from the sofá at night on a
  phone, or on a 1880px monitor beside dark WezTerm panes. A light theme would be a surface
  pretending it doesn't live in a terminal room. No `prefers-color-scheme` fork on purpose.
- **Accent: verdigris teal `#56c8bc`.** NOT the kitchen's amber (that surface owns amber); not
  semantic green/red (state colors must stay louder than chrome). Teal = control-room phosphor,
  the fleet's own color. Semantic: ok `#41c463`, bad `#f0564f`, warn `#d9a03f`.
- **System fonts only** (zero CDN): Segoe UI stack + Consolas/Cascadia mono with
  `font-variant-numeric: tabular-nums` for every number/id.
- **Cockpit density:** 1px lines and negative space group data; the ONLY elevated cards are
  decision cards — the one thing that earns elevation is a decision demanding the operator's hand.
- **Motion:** 140–200ms ease-out, `scale(0.97)` press feedback, reduced-motion honored.

## Deviations / additions vs the spec IA (with reasons)

1. **DECISIONES also lists steward findings** ("Hallazgos del steward", non-operator categories,
   marked SIN FALLO when the gate is red about them). Reason: pane-0's loop-proof designation
   (rule idle findings T-0031/T-0013 via the UI) exposed that operator-gated tasks alone don't
   cover everything a ruling can land on. Same card, same actions; the server derives `category`
   from the live finding so lines stay schema-exact.
2. **`approved` rulings are mirrored into `_intel/operator-actions.jsonl`** (kind `approval`).
   Reason: the gate's own vocabulary treats unknown words as no-cover and `awaiting-operator`
   findings are never gated, so an approval line alone would reach nobody; the mirror is what the
   orchestrator's 60s monitor fires on. Deferrals/cancellations are complete in themselves (the
   gate reads them directly) and are not mirrored.
3. **Verbs map 1:1** to the `ruling` field: `approved|deferred|cancelled`. Field set is exactly
   the existing schema `{task, category, ruling, why, at}` (+`until` for deferrals). Proven by
   test: `test/board-server.test.cjs` asserts key-set equality and `rulingCovers` behavior.
4. **Kitchen pill** reads `BOARD_KITCHEN_HEALTH_URL` (probed server-side, 1.5s timeout). Unset →
   "sin configurar" (gray), never a guessed verdict.
5. **Vanilla CSS, no Tailwind/framer-motion.** Zero-CDN law + a 51KB-gzip bundle; the design
   system is hand-built in `src/styles.css`.
6. **Browser walk ran under Playwright** (`walk.cjs`, `loop-proof.cjs`) because the
   claude-in-chrome extension was disconnected; per the operator's standing fallback rule. The
   walk is scripted and reproducible: 1880px + 390px, forced error/empty states, console-error
   capture (zero unexpected), PWA + LAN checks. Evidence: `.orchestrator/T-0140-shots/`.

## Security (pane-0 binding constraints, applied)

- **Token-or-loopback:** non-loopback bind REQUIRES a token; `loadToken()` self-provisions into
  gitignored `board-app/.env.local`; if that fails the server binds `127.0.0.1` only. The token
  value is never logged and never committed.
- **Rate limit:** per-IP sliding window (10 POSTs/min) on the append endpoints; rejected requests
  count toward the cap on purpose.
- Constant-time token compare; 16KB body cap; verb/kind whitelists; `until` must be future-dated.

## Known limits

- **PWA install over plain-HTTP LAN:** Chrome requires a secure context for SW/install, so over
  `http://192.168.x.x` the app runs fully but no install prompt appears. Install works on the
  serving machine (localhost is a secure context). If sofá-install matters, front it with HTTPS
  (Caddy/WireGuard hostname) — deliberately out of T-0140 scope.
- Feed type-filters apply client-side to loaded pages; pagination stays server-side (25/pull).

## Ops runbook

- Server: `node board-app/server.cjs` — port `WEZBRIDGE_BOARD_PORT` (default 4272), binds 0.0.0.0
  with token. Task Scheduler: **`wezbridge-fleet-board`** (logon + 1-min repetition; the
  idempotent launcher `start-board-server.ps1` makes repetition a restart-on-death loop).
  Install/remove: `install-task.ps1 [-Uninstall]`. Kill-proof observed 2026-08-16: killed
  00:09:42-03, auto-revived 00:10:04-03 (22s), task result 0.
- Logs: `board-app/server.log` / `server.err.log` (launcher-spawned instances).
- Token: `board-app/.env.local` (`BOARD_TOKEN=…`), shown once to the phone, stored in
  localStorage after first entry.
- Tests: `node --test test/board-server.test.cjs` (part of the fleet suite).
- The legacy static `scripts/fleet-board.cjs` board KEEPS regenerating (criterion 7); it retires
  only after the operator uses this app for a real decision.

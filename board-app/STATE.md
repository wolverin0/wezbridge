<!-- doc-head: T-0140/T-0143 fleet board app STATE - design decisions, spec deviations, ops runbook.
Covers: React/Vite PWA cockpit in board-app/, bare-node server.cjs :4272, ruling verb mapping,
the T-0143 TASK_TRANSITION whitelist (the ONLY task-state writes this app performs), deferred-card
hiding, banned UI vocabulary, task detail panel, token-or-loopback bind, Task Scheduler hosting
(wezbridge-fleet-board), PWA/LAN limits, Playwright walk scripts.
Read when: operating the board, auditing T-0140/T-0143, changing the API or any task-state write. -->

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

## T-0143 — the three operator-found defects (2026-08-16, pane-48)

The operator used the board for real, cancelled T-0126 and T-0129, and both cards came back on
every refresh. Full spec: `_intel/briefs/T-0143-board-app-decision-defects.md`.

### D1 — a terminal ruling now MOVES the task

`TASK_TRANSITION` in `server.cjs` is the complete, exhaustive list of task-state writes this
process can perform. A whitelist, not a door; the test asserts its key set equals `VERBS`, so no
verb can fall through undeclared.

| verb | ruling written | task write |
|---|---|---|
| Cancelar | `cancelled` | `state: cancelled` |
| Aprobar | `approved` | `state: ready` **and `contract.gate` cleared to `null`** |
| Diferir | `deferred` + `until` | none — card hides only |
| Nota | none | none |

- **Approve MUST un-gate, not just restate.** DECISIONES is built from open tasks with
  `gateOf(t) === 'operator'`, and `ready` is an OPEN state, so a state-only move would leave the
  approved card on screen forever — the very defect being fixed. Only `contract.gate` is cleared;
  `mode`, `allowed_paths`, `evaluator` and `_note` survive (asserted by test).
- **The ruling word for Aprobar stays `approved`,** not `dispatched`. The brief's table says
  "`dispatched` (as today)" but today writes `approved`; "(as today)" is the operative constraint
  and pane-0 confirmed. `approved` is deliberately NOT in `steward-gate`'s `rulingCovers`
  vocabulary, so it covers nothing — harmless here precisely because clearing the gate moves the
  task out of `awaiting-operator` entirely. If nobody then does the work it resurfaces later as
  ordinary `idle`. **That resurfacing is correct behaviour. Do not add a permanent cover to
  silence it.**
- **Order is the contract:** the ruling is appended FIRST and is the source of truth.
  `applyTransition()` never throws; a failed task write returns `{applied:false, error}` and the
  API answers 200 with `{ok, line, transition}`. The UI then shows an amber half-success toast
  naming which half happened and telling the operator NOT to resend (resending would double-write
  the ruling). A 500 here would be a lie in the other direction.
- Every transition records WHO/WHAT/WHEN/WHY in the task's own `next_action`, wording following
  the line pane-0 wrote by hand on T-0126. A state change whose cause lives only in another file
  is the same defect class as a ruling that never lands.
- Path is re-validated against the tasks dir inside `applyTransition` even though `validateRuling`
  already whitelists the id charset: a whitelist enforced only upstream is one refactor from being
  a traversal.

**Deferred hiding** reuses the gate's own `rulingCovers` rather than a second date rule — but
**scoped to `deferred` rulings only**. `dispatched` also covers (24h grace), and honouring that
would silently hide a live operator gate for a day because somebody dispatched something; making a
decision vanish is worse than the defect being fixed. Hidden cards are counted back into
`deferred_hidden[]` and shown as "N diferidas, ocultas hasta su fecha" — hidden never means gone.

### D2 — the word *fallo* is BANNED from this UI

`Fallo registrado para T-0129` read to the operator as "FAILURE recorded" on his own successful
action. *Fallo* is correct legal Spanish and matches the `rulings.jsonl` vocabulary; he is the only
user, so he is the arbiter. Confirmations are now verb-specific and name the consequence
(`T-0129 cancelada.` / `aprobada — pasa a la cola de trabajo.` / `diferida hasta <fecha>.` /
`Nota enviada al orquestador.`). Swept from Decisions/App/TopBar/Activity; the shipped bundle greps
clean. The only occurrence left in the repo is the comment in `App.tsx` recording the ban.

### D3 — task rows carry what you decide with

`detailOf()` projects goal/next_action/blocker/acceptance_criteria/depends_on/lease/corr/refs onto
decisions, in_flight and by_repo (open tasks only, so the payload stays small). `TaskDetail.tsx`
expands in place — no navigation, no modal, and NOT a card (a card inside a decision card is nested
elevation that means nothing).

**Ordered by the question, not by the shape of the JSON.** The adjacent failure to "rows say
nothing" is "a wall of dumped fields", and it is the likelier one:

1. **Qué necesita ahora** — blocker if present, else next_action. Full ink, largest, first. Blocker
   outranks next_action: if something is in the way, that is what it needs whatever the plan said.
2. Para qué existe (goal), quieter.
3. Cómo se sabe que terminó (acceptance criteria as a numbered list).
4. A three-item strip: dueño (flagging an expired lease as reclaimable) · repo · tocada.
5. Everything else — corr, kind, attempt, contract mode, depends_on, context_refs, created, file
   path — folded behind `más`. Hiding them is the design choice; deleting them would not be.

A decision card already renders the blocker as the question, so the panel is passed `shown` and
drops an identical lead rather than printing it twice (caught by reading the first screenshot, not
by a test). Long text WRAPS everywhere — there is deliberately no line-clamp in the panel, because
a truncated blocker is the same defect as no blocker.

### Design-process deviation (stated, not silent)

The spec mandates five design skills before UI code. Invoked `taste-skill` and `impeccable`.
Skipped `frontendgame`, `emil-design-eng`, `ui-ux-pro-max` deliberately: this is a defect fix
inside an already-committed design system, pane-0 instructed not to re-litigate the design
language, and no new motion, palette or type work is in scope. Accepted by pane-0 with the caveat
that D3 is a genuinely new surface and would be judged on hierarchy — which is why the panel was
restructured around the five-second question above. One concrete catch from `impeccable`: the first
draft of `.tneed` used a 2px colored `border-left`, which is its named side-stripe ban; replaced
with label-color and ink-weight emphasis.

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
- Tests: `node --test test/board-server.test.cjs` (part of the fleet suite). 27 cases at T-0143.
- Browser walks: `walk.cjs` (T-0140) and `walk-0143.cjs` (T-0143, 19 checks / 12 shots →
  `.orchestrator/T-0143-shots/`). `walk-0143.cjs` boots a SECOND server IN-PROCESS on `:4273`
  against a temp `_intel` copy for the destructive verbs — cancelling and approving move task
  state, and seeding synthetic gated tasks into the live control plane to produce a screenshot is
  never acceptable. Part B then drives the LIVE `:4272` board read-only for the detail panel on
  real long-text tasks (T-0008, T-0105); `_intel/tasks` + `rulings.jsonl` are diffed before/after
  and must come back unchanged. wezbridge keeps zero dependencies, so playwright is borrowed from
  a sibling project's `node_modules` (override with `WALK_PLAYWRIGHT`).
- The legacy static `scripts/fleet-board.cjs` board KEEPS regenerating (criterion 7); it retires
  only after the operator uses this app for a real decision.

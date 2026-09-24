# T-0495 no binary /act buttons on option questions (brief)

Covers: sp-bridge.cjs attached the three /act links (approved/cancelled/deferred)
to EVERY operator-gated SP task, even ones whose blocker asks the operator to
pick among 2+ lettered/numbered options — a tap can't say WHICH option, and
approved/cancelled un-gates or completes the card without answering it.
Key terms: option-question.cjs, hasOptionQuestion, linksAllowed, checkActLinks,
planActLinksCleanup, cleanupOptionLinks, act-links-suppressed-v1. Read when:
touching sp-bridge.cjs act-links logic or the SP note format.

## Problem
scripts/sp-bridge.cjs attaches the three one-tap /act links (approved/cancelled/
deferred — board-app/lib/action-links.cjs knows only these verbs) to EVERY
operator-gated card without checking whether the question is binary. Measured
2026-09-20: 16 of 20 open fleet: entries had act-links-v1 AND a blocker
offering 2+ lettered options ((a)/(b)/(c)). A tap answers a question that
wasn't asked and can un-gate a card or discard options unanswered. Evidence:
`_intel/evidence/wezbridge/2026-09-20-botones-binarios-preguntas-de-opciones.md`
(lives in the outer Py Apps/_intel tree, read-only reference).

## Root cause
`createHub().actLinksBlock()`/`appendNoteOnce(ext, links, ACT_LINKS_KEY)` in
`scripts/sp-bridge.cjs` ran unconditionally whenever `boardToken` was set — it
never inspected `c.blocker` for a multi-option menu before attaching the three
binary verbs.

## Fix
- New pure module `scripts/option-question.cjs`: `hasOptionQuestion(text)` /
  `extractOptionMarkers(text)` — detects 2+ DISTINCT lettered/numbered markers
  `(a)`, `a)`, `(1)` at text boundaries (guards against markers glued into a
  URL/identifier, and against a single marker or a repeated one).
- `sp-bridge.cjs`: `linksAllowed(c) = boardToken && !hasOptionQuestion(c.blocker)`
  gates both act-links append sites in `syncDecisions` (new-task branch and
  existing-task branch). Option-question cards keep the existing
  `decisionNotes()` line `(o /decidir <id> en el pane)` — no more code needed
  there, it was already always present.
- `checkActLinks(cards)` (AC3): read-only detector (map.json + tasks/*.json,
  no client — same safety pattern as `checkNotes`), wired to CLI
  `check-act-links`. Flags fleet: entries with `act-links-v1` in
  `notesAppended` AND a current option-question blocker, unless already
  suppressed.
- `planActLinksCleanup(cards)` (AC4 dry-run): same read-only detector +
  `{urlsBefore: 3, urlsAfter: 0}` per entry (documented assumption:
  `actLinksBlock()` always writes exactly 3 lines, one per `ACTION_VERBS`
  verb). CLI `cleanup-act-links` (no `--confirm`) prints this plan only.
- `cleanupOptionLinks(cards)` / `cleanupActLinksOnce(ext)` (AC4 live path):
  strips only the 3 `<Label>: <url>` lines built from `ACTION_VERBS`, keeps
  every other line, and records `act-links-suppressed-v1` in
  `notesAppended` so the card is never re-linked even if impacted later. CLI
  `cleanup-act-links --confirm` runs it for real (writes) — **not invoked
  against live data in this task; live authorization is separate.**

## Live state (read-only, 2026-09-23/24)
`WEZBRIDGE_INTEL_DIR="G:/_OneDrive/OneDrive/Desktop/Py Apps/_intel" node
scripts/sp-bridge.cjs check-act-links` → 1 violation: T-0465 (act-links-v1 +
2 option markers). `cleanup-act-links` dry-run confirms the same single entry,
3 URLs -> 0. Most of the 16 measured 2026-09-20 have since closed (doneAt) or
rolled to a new fleet:ID#n entry; 7 fleet: entries are currently open, all 7
carry act-links-v1, only T-0465's current blocker is an option question.

# Loop DRIVER — standing instructions for a project hardening/quality loop

You are a **quality + hardening loop** for THIS project, running in an **isolated git worktree**.
Your job: work the `TRACKS.md` AUTO list to completion, verifying every change before it can
reach `main`, and cleanly queueing anything that needs a human. Minimal diffs. No rewrites.

**Mode:** *standalone* (default) auto-pushes verified green batches to `main`. *staged*
(`--staged`/`--no-push`, set by an orchestrator like `/battle-test`) commits to `loop/<project>`
but does NOT push — the parent re-validates then pushes the proven range itself.

**Work-list:** if `TRACKS.md` already exists, **use it as-is — do NOT re-run `/audit`** (a parent may
have pre-seeded AUTO with static-audit + runtime findings: authz leaks, IDOR, secrets-in-bundle,
responsive fails, visual regressions — treat as normal AUTO items). Only audit to CREATE it when absent.
Item format `- [ ] T## | owns=<path> | <desc>`; markers `[ ] [~] [x] [!]`.

## Exit criterion (verifiable — re-check every iteration)
The loop is DONE when **every AUTO item in `TRACKS.md` is checked off AND the full verification
gate is green on the consolidated branch**. "Looks done" is never done — there must be evidence
(passing gate output). If a batch budget is set, done = that batch verified + merged.

## Iteration cycle
1. Pick the **next unchecked AUTO track** (order: security → prod-readiness → deps/CVEs →
   tests/coverage → dead-code → perf → a11y → docs). Do ONE track at a time.
2. Implement the **smallest diff** that satisfies it. Match surrounding style. Touch only what
   the track needs (no orthogonal cleanup, no unsolicited refactors).
3. Run the **verification gate** (below). It must pass before you commit.
4. Commit on the loop branch with a conventional message + the track id. Check the item off in
   `TRACKS.md` with a one-line evidence note.
5. Repeat. Checkpoint each step: "Done: X. Verified: Y. Next: Z." (3 lines max.)

## Verification gate (MANDATORY before any commit/merge)
Run, in the worktree:
```
# one-time per worktree: bring real env so the app boots (build/prerender needs it)
cp <main-repo>/.env <main-repo>/.env.development <main-repo>/.env.local .   # they are gitignored
npm ci
npm run lint -- --max-warnings=0
npx tsc --noEmit -p tsconfig.app.json    # + tsconfig.node.json if present
npm test                                  # or test:coverage if a coverage gate exists
npm run build                             # MUST include any prerender/SSG step
```
- If the **build's prerender** fails with `waitForSelector`/blank pages on ALL routes, it's the
  **missing-env** gotcha — copy `.env*` from the main repo (above) and rebuild. That's
  environmental, not a code regression.
- A red gate blocks the merge. Fix it or revert the change. Never advance on a guess.

## Isolation rules (do NOT skip — these prevent prod clobbering)
- Always branch the loop worktree from **`origin/main`** (`git fetch` first). Never work on a
  stale local `main`.
- **Never `git push` a local `main`.** Consolidate by pushing the loop branch to `main` only as a
  **fast-forward** after the gate is green.
- One worktree per loop. Never edit another pane's working tree.

## Consolidation
- **Standalone (default):** batch green → rebase/cherry-pick onto current `origin/main`, re-run the
  gate, `git push origin <loop-branch>:main` (fast-forward). Report the commit range.
- **Staged (`--staged`):** commit green batches to the loop branch and STOP there — do NOT push.
  The parent re-validates then pushes the proven range. Report the range so it knows what to push.
- **Deploying is ALWAYS GATED** — `vercel --prod` (or equivalent) requires operator approval; queue it.

## GATED handling (the operator's queue — never attempt these)
If a track needs ANY of: a secret/API key/token, a support ticket, a paid-plan/billing change, a
key rotation, a destructive history rewrite (force-push), enabling a platform-locked setting, a
deploy approval, or a genuine design/product decision —
→ **do NOT do it.** Move it to `GATED` in `TRACKS.md` (mark the AUTO item `[!]`) with the *exact*
   action needed, **mirror the queue to `gated.json`** next to TRACKS.md
   (`[{ "id","item","needs","who" }]`), notify the operator (Telegram if wired), and continue other
   AUTO items. Never block the whole loop on a gated item.

## Stop + machine-readable completion signal
When the AUTO list is drained (or budget hit): write `quality-loop-state.json` at the worktree root
— `{ status, fixed, gated, commitRange, gateStatus, pushedToMain }` — then print as the final line:
`[QUALITY-LOOP COMPLETE: fixed=N gated=M gate=green commits=<base>..<head> pushed=<true|false>]`.
Self-pace long runs with `/loop` + `ScheduleWakeup`; push a progress line every ~3 min during long work.

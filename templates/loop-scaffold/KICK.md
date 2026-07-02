# KICK — how to run the loop on a project (manual)

No schedulers, no daemons. You start one project's loop in one pane when you want it. The loop does
the AUTO work, verifies, consolidates to `main`, and queues GATED items for you.

## One-time per project: scaffold + audit
```bash
# 1. drop the scaffold into the project
cp -r <wezbridge>/templates/loop-scaffold/.loop  <project>/.loop
cp    <wezbridge>/templates/loop-scaffold/TRACKS.md  <project>/TRACKS.md   # then edit the header

# 2. seed TRACKS.md from an audit (so the loop has a real work-list, AUTO vs GATED)
#    in the project pane:  /audit        (or a quick scan)  → fill AUTO/GATED sections
```

## Each run: kick the loop
```bash
# 3. make an isolated worktree from the DEPLOYED main (never a stale local main)
cd <project> && git fetch origin
git worktree add ../_worktrees/<project>-loop -b loop/<project> origin/main

# 4. bring real env so build/prerender can boot the app (gitignored — won't commit)
cp .env .env.development .env.local ../_worktrees/<project>-loop/ 2>/dev/null

# 5. open a pane in the worktree and start the loop with a checkable goal:
#    claude   (in ../_worktrees/<project>-loop), then paste:
```
> Read `.loop/DRIVER.md` and `TRACKS.md`. Run the loop: work the AUTO list top-to-bottom, one track
> at a time, self-verifying with the full gate before each commit. Consolidate green batches onto
> `main` as fast-forwards. Queue every GATED item with the exact action needed — never attempt them.
> Stop when the AUTO list is drained, with a summary + the GATED queue. `/loop`

## Your only recurring job: drain the GATED queue
Open `TRACKS.md` → `GATED` section. Each line tells you the exact action (rotate a key, file a
ticket, approve a deploy, create a Turnstile widget…). Do it, then tell the loop to verify + proceed.

## When the loop finishes
- It pushed verified work to `main` (deploy still GATED — you run `vercel --prod` when ready).
- Hand the project back to its normal pane, or close the loop pane + remove the worktree:
  `git worktree remove ../_worktrees/<project>-loop`

## Gotchas baked in (don't relearn them)
- Build/prerender fails with `waitForSelector` on ALL routes → missing `.env*` in the worktree (step 4).
- `git reset --hard` against main is guardrail-blocked → use `git checkout -B main origin/main`.
- Cherry-pick of an already-shipped commit returns "empty" (not a conflict) → `--skip`.
- Never push a stale local `main`; the loop always branches from `origin/main`.

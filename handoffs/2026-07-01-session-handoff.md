# Session Handoff — 2026-07-01

> Purpose: resume cleanly after `/clear`. This session got very long (758k ctx); everything below is
> saved to MemoryMaster too. Read this first, then the referenced files only as needed.

---

## 🔴 ACTIVE TASK (do this first on resume)
**Skill-library cull, awaiting the user's keep-list file.**
- A keep-list report was generated & opened: **`wezbridge/artifacts/2026-07-01-skill-keeplist.html`**
  (97 local skills, checkboxes all default-checked, badges keep/overlap/review/family, Export button).
- The user unchecks skills to remove, clicks **Export KEEP list** → downloads **`skills-keep-2026-07-01.txt`**
  (one folder-name per line = the skills to KEEP).
- **On resume, when the user hands back that file:** archive every LOCAL skill folder NOT in the list
  (both `~/.claude/skills/<name>` and `~/.codex/skills/<name>`) → move to
  `~/.claude/_skills-archive/2026-07-01/<name>__{claude|codex}` (reversible; `mv` back to restore).
  Report what moved. **Do NOT touch plugin skills** (they're managed, not in `~/.claude/skills`).
- After the cull: offer to **align the 9 folder≠name mismatches** (see below) for kept skills.

## Pending decisions (surface, don't auto-do)
- **9 name/folder mismatches** — `/frontendgame` etc. won't resolve because folder ≠ frontmatter `name:`.
  Affected: design-skill, frontendgame(`endgame-mobile-product-design`), graphify, mercadopago-memory,
  output-skill, saleor-storefront, shadcn-ui-kit, taste-skill(`design-taste-frontend`), ui-styling.
  Fix = set frontmatter `name:` to the folder name. Offer after the cull.
- **Plugin bloat** — `/context` shows 325 skills but only 9.9k tokens (1%); skills are NOT context bloat
  (metadata-only load). The 241 *plugin* skills are the "too many" feeling. Lever = disable unused
  plugins (claude-seo 33, compound-engineering 39, sparc/github families). Only if the user asks.
- **Context hygiene** — real bloat this session = ~500k of claude-in-chrome screenshots in message
  history. Skills are irrelevant to context. Compact by task boundary, not skill count.

---

## ✅ DONE THIS SESSION (brief resume — reference files/claims for detail)

### 1. FuturaCRM (argentina-sales-hub) — security remediation SHIPPED + handed off
- **Storage-RLS breach found + PROVEN**: with the public anon key, anyone can download private
  invoices/receipts (RLS disabled on `storage.objects`; unfixable via token/dashboard — Supabase-support-only).
- **Supabase support ticket SUBMITTED** (High, project crmargentina). Draft: `argentina-sales-hub/SUPABASE-SUPPORT-RLS-REQUEST.md`.
- **All remediation branches consolidated → pushed to origin/main** (`fbff2ab → e305855`, verified green).
  NOT yet deployed (manual `vercel --prod`). Handoff to its own pane: `argentina-sales-hub/HANDOFF-orchestrator-2026-06-29.md`.
- **Operator-gated residuals**: enable RLS (Supabase support), rotate the exposed sbp_ token + keys,
  deploy, g4-captcha (needs Turnstile keys), g2 git-history purge (mirror ready, force-push after rotation).
- Backups: `_backups/futuracrm-20260628/`. Memory: claims mm-8b4e, mm-427c, mm-543e.

### 2. The Loop stack (Andrew Ng "loops" pattern, Claude-only, local)
- **`quality-loop`** skill = autonomous project hardening/quality-sweep loop in an isolated worktree
  (AUTO/GATED TRACKS.md, self-verify gate, fast-forward main). Portable scaffold:
  **`wezbridge/templates/loop-scaffold/`** (DRIVER.md, TRACKS.md, KICK.md). Playbook:
  `wezbridge/artifacts/2026-06-25-loop-engineering-playbook.html`.
- **`battle-test`** = E2E orchestrator (diagnose→verify→harden→re-verify→report) that CONDUCTS quality-loop
  as Stage 3. quality-loop got `--staged` (no-push) mode + `quality-loop-state.json` completion signal
  for it. Both copied to `~/.codex/skills/` too. Memory: mm-eafc.
- Feature work ≠ quality-loop → use **`/rpi`** (spec→slices→build-loop). brainstorm(define what) vs
  ultrathink(reason deep) are distinct + compose.

### 3. Skill-evolution system (self-improving loops, done right)
- **Capture hook** (`~/.claude/hooks/skill-run-capture.cjs`, registered as 2nd Stop hook) →
  `~/.claude/skill-runs/<skill>.jsonl` (objective signal from state files + recurring corrections).
  Codex twin: `~/.codex/hooks/skill-run-capture-codex.cjs` + `~/.codex/hooks.json` (pools to SAME log).
- **`/skill-evolve`** = independent reviewer; proposes surgical SKILL.md diffs only on ≥3 recurring
  patterns; human/eval-gated (`--apply`). Smoke-tested (found+fixed a false-positive-corrections bug +
  a real env-precondition gap in quality-loop). Memory: mm-64b2, mm-269b, mm-8b4e.

### 4. Skill-library cleanup (the CURRENT thread)
- Archived (all reversible in `~/.claude/_skills-archive/2026-07-01/`): `feature-validation`,
  `autoresearch.bak`, `skill-builder`, `superskills-brainstorm`+`brainstorming` (byte-dup of superpowers plugin).
- **superpowers plugin updated 4.3.1 → 6.1.0** (restart to apply).
- **Merged** project-setup + project-curate + project-doctor → new **`project-health`** skill
  (default=check/read-only, `--apply`=remediate; check.js carried over). Old 3 archived.
- **Frontend trigger-descriptions rewritten** (Option A): `frontendgame`=PRIMARY UI builder,
  `emil-design-eng`=animation niche, `taste-skill`=engineering-discipline niche. Memory: mm-0348, mm-3d95.

---

## Key paths
- Skills: `~/.claude/skills/`, `~/.codex/skills/` | Archive: `~/.claude/_skills-archive/2026-07-01/`
- Loop scaffold: `wezbridge/templates/loop-scaffold/` | Skill-runs log: `~/.claude/skill-runs/`
- Artifacts: `wezbridge/artifacts/` (skill-keeplist, skill-cleanup-map, skill-reference, loop-playbook)
- FuturaCRM: `argentina-sales-hub/` (SUPABASE-SUPPORT-RLS-REQUEST.md, HANDOFF-orchestrator-2026-06-29.md)

## MemoryMaster note
`ingest_claim` was failing late-session with `table claims has no column named holder` (schema drift) —
may need a migration/`run_cycle`. Recent claim IDs: mm-8b4e, mm-0348, mm-3d95, mm-eafc, mm-269b, mm-64b2.

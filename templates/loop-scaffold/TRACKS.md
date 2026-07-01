# TRACKS — <PROJECT NAME>

> Work-list for the hardening/quality loop. **AUTO** = the loop does it + verifies it.
> **GATED** = needs the operator or an external action; the loop only surfaces these, never does them.
> Single source of truth. Seed from an audit (`/audit`) — OR an orchestrator (`/battle-test`)
> pre-seeds AUTO with static-audit **and** runtime findings; in that case the loop works it as-is
> and does NOT re-audit.

**Project:** <name>  ·  **Repo:** <git remote>  ·  **Deploy:** <e.g. manual `vercel --prod`>
**Loop branch:** `loop/<project>`  ·  **Worktree:** `../_worktrees/<project>-loop`

**Item format:** `- [ ] T## | owns=<path> | <desc>`
**Status markers:** `[ ]` todo · `[~]` in-progress · `[x]` done · `[!]` blocked (moved to GATED)
**AUTO order (do-no-harm-first, do not reorder):** security → prod-readiness → deps/CVEs →
tests/coverage → dead-code → perf → a11y → docs.

---

## AUTO — the loop owns these (work top-to-bottom; smallest diff each)

### security
- [ ] T01 | owns=<path> | auth on every protected route + ownership/RLS on every user-data path (test: change the id in the URL; covers IDOR)
- [ ] T02 | owns=<path> | no secrets/service_role key in client bundle; server-only env via process.env
- [ ] T03 | owns=<path> | input validated server-side; parameterized queries only
- [ ] T04 | owns=<path> | no raw error.message / stack to clients on 5xx
- [ ] T05 | owns=<path> | no authorization leak (a low role can reach a higher-role route/resource)

### prod-readiness
- [ ] T06 | owns=<path> | every UI component has loading / error / empty / success states
- [ ] T07 | owns=<path> | expensive/paid/AI/auth endpoints rate-limited (+ spend-capped)
- [ ] T08 | owns=<path> | heavy ops async (job + id + idempotency), not inline
- [ ] T09 | owns=<path> | structured logging + error tracking (not console.log)

### deps
- [ ] T10 | owns=package.json | `npm audit --omit=dev` = 0 high/critical (dev/transitive → note/defer)

### tests
- [ ] T11 | owns=<path> | suite green + stable (de-flake env/cache-key drift); coverage gate met; tests anchor on the requirement

### dead-code   (big-diff — keep each removal reviewable)
- [ ] T12 | owns=<path> | knip/ts-prune accurate; remove confirmed dead code in small batches

### perf
- [ ] T13 | owns=<path> | cold-load bundle budget guard; code-split heavy chunks; fix responsive overflow (e.g. /x overflows at 390px)

### a11y
- [ ] T14 | owns=<path> | axe on public routes, no serious/critical; aria-hidden on decorative

### docs
- [ ] T15 | owns=<path> | doc-drift guard; fix stale paths/commands; AGENTS.md/CLAUDE.md accurate

---

## GATED — operator / external only (loop surfaces, never acts; also mirror to gated.json)
> Format: `- [!] T## | <item> | NEEDS: <exact action> (who/where)`

- [!] T## | <e.g. enable storage RLS> | NEEDS: support ticket / dashboard toggle (operator)
- [!] T## | <e.g. CAPTCHA> | NEEDS: create Turnstile widget → set VITE_TURNSTILE_SITE_KEY + Auth secret (operator)
- [!] T## | <e.g. deploy> | NEEDS: operator runs `vercel --prod`
- [!] T## | <e.g. key rotation> | NEEDS: operator rotates <which keys>
- [!] T## | <e.g. history purge> | NEEDS: force-push after key rotation (coordinate)

---

## Log (append-only — what the loop shipped)
- <date> <commit-range> — <T##> — <evidence>

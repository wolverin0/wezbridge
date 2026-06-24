# Skills Inventory - Orchestrator

Snapshot: 2026-05-16.

## Global

Global skill roots scanned:

- `C:\Users\pauol\.codex\skills`
- `C:\Users\pauol\.agents\skills`

Relevant global families for orchestration:

- Audit: `audit-orchestrator`, `audit-method`, `audit-domain-*`,
  `audit-hard-stops`, `audit-blind-spots`, `audit-tambon-hunt`,
  `audit-fix-generator`, `audit-decisions`.
- Validation: `validation`, `feature-validation`,
  `validation-playwright-mcp`, `visual-verification-harness`,
  archived validation variants under `.agents\skills\_archive`.
- UI/UX: `ui-ux-pro-max`, `frontend-design`, `design-taste-frontend`,
  `ui-styling`, `impeccable`.
- Project setup/repair: `project-setup`, `project-curate`,
  `debug-resolve`, `deploy-verify`.
- Integration/payment: `mercadopago-integration`, `supabase-debug`,
  CRM/GitHub/deploy skills.
- Coordination: `pair-programming`, `swarm-orchestration`,
  `swarm-advanced`, `stream-chain`, `hooks-automation`, `debate`.

Gotcha:

- `C:\Users\pauol\.codex\skills\audit-loop\SKILL.md` currently has invalid
  YAML and appears in Codex pane startup output. Do not route work to
  `audit-loop` until repaired.

## Project-Scoped

Only project-local `.claude\skills`, `.codex\skills`, and `.agents\skills`
were counted. Vendored `node_modules`, cloned research repos, temporary
extension caches, and `clawdbot-temp` were excluded from the curated count.

| Project | Project-scoped skills | Notes |
| --- | ---: | --- |
| `wezbridge` | 0 | Use global orchestration/audit/validation skills. |
| `memorymaster` | 6 | GitNexus skills under `.claude\skills\gitnexus`. |
| `personaldashboard` | 0 | Has many `clawdbot-temp` skills, treated as vendored/temp. |
| `whatsappbot-final` | 77 | Rich `.agents` and `.claude` skill sets; project-local routing preferred. |
| `lifeagent` | 0 | Use global skills unless project skills are added. |

## Routing Rule

The orchestrator should recommend the skill family, then let the target project
pane execute project-local skills when available. Global skills are the
fallback for projects with no curated local skill set.

For audits, keep the audit family grouped globally for now. Do not promote
project-specific skills globally unless they are reusable across projects.

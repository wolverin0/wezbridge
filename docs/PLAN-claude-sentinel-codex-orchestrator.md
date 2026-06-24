# PLAN - Claude Sentinel + Codex Orchestrator

> Status: draft created 2026-05-16 after live A2A smoke test.
>
> Goal: make wezbridge the local "knower/coordinator" for active projects
> without reviving the bloated central orchestrator failure mode.

---

## 0. Decision

Use a hybrid control loop:

- Claude pane is the long-lived sentinel because Claude has `Monitor`,
  Telegram channels, and can stay event-driven.
- Codex pane is the on-demand orchestrator because it is stronger at compact
  planning, code review, implementation judgment, and plan authoring.
- MemoryMaster is the knowledge substrate. The orchestrator gets bounded
  context through `query_for_context` / `query_for_task`, never whole claim
  dumps or raw scrollback history.
- wezbridge is the transport layer: discover panes, map human-visible tabs to
  stable pane IDs, send A2A prompts, read outputs, spawn workers, and recover
  sessions.

This is not a return to the old browser dashboard or autonomous
`orchestrator-worker`. The central context stays small. Every project-specific
question should be answered by querying the target pane, its project files,
MemoryMaster, or a bounded sidecar/subagent.

---

## 1. Live Smoke Test

Date: 2026-05-16.

Input:

- pane 33, Codex, acted as orchestrator.
- pane 0, Claude in the wezbridge repo, acted as sentinel.
- Codex sent a synthetic A2A `worker_idle` event to pane 0.
- MemoryMaster `query_for_context` returned an empty bounded context block.

Result:

```text
[A2A from pane-0 to pane-33 | corr=sentinel-wake-smoke-20260516 | type=result]
```

Pane 0 returned compact JSON:

```json
{
  "ok": true,
  "role": "sentinel",
  "received_event": "worker_idle",
  "decision": "wake_codex",
  "memory_context_used": true
}
```

What this proves:

- `send_prompt` + explicit `send_key("enter")` can wake the Claude sentinel.
- The sentinel can classify a watcher event and return machine-readable A2A.
- Empty MemoryMaster recall is a valid input, not a blocker.
- Codex can poll/read the sentinel output through wezbridge.

What this does not prove yet:

- Persistent wake into the actual Codex orchestrator pane from the Claude
  sentinel while Codex is idle.
- Debounce/cooldown behavior.
- Real `Monitor` event feed.
- Telegram inbound/outbound routing.
- Multi-project coordination quality.

Next smoke test: send a second `worker_idle` event inside a cooldown window and
require `decision: "do_not_wake"` with `reason: "cooldown"`.

---

## 2. Product Intent

The target behavior is:

> From anywhere, ask the local orchestrator what each live project needs next,
> have it talk to the relevant panes, inspect project state, consult
> MemoryMaster, recommend or dispatch the next goal, and enforce real
> validation when work is done.

Example user command:

```text
What should memorymaster and lifeagent do next?
```

Expected flow:

1. Orchestrator resolves human-visible tabs/projects to panes.
2. Sentinel or Codex asks each pane for current status, roadmap, active goal,
   blockers, and confidence.
3. Codex queries MemoryMaster for bounded project context.
4. Codex decides whether the project needs implementation, audit, UI polish,
   validation, docs, release work, or a new `/goal`.
5. Sentinel dispatches the chosen prompt to the right pane or asks the user for
   approval when the next action is expensive/destructive.

---

## 3. Non-Goals

- Do not load all project knowledge into one mega-context.
- Do not make the dashboard UI the control surface.
- Do not let Claude blindly execute Codex decisions without safety gates.
- Do not treat pane IDs as user-facing identifiers when tab labels are what
  the user can see.
- Do not replace MemoryMaster with scrollback.
- Do not run audits/validation as theater. Validation must include the actual
  app surface when relevant, especially Playwright/browser checks for UI work.

---

## 4. Core Loop

```text
Claude sentinel pane
  Monitor / Telegram / wezbridge event watcher
  detects idle, permission, ctx threshold, completion, user DM
  fetches bounded MemoryMaster context when useful
  sends compact A2A event to Codex orchestrator

Codex orchestrator pane
  receives event packet
  queries MemoryMaster / project files / target pane as needed
  returns structured decision

Claude sentinel pane
  routes decision to worker pane, asks user, or waits
  ingests important decisions/gotchas into MemoryMaster
```

Decision schema for v0:

```json
{
  "ok": true,
  "decision": "act|ask_user|spawn_peer|run_validation|run_audit|wait|handoff|ingest",
  "target_pane": 0,
  "target_project": "wezbridge",
  "reason": "...",
  "prompt": "...",
  "requires_user_approval": false,
  "memory_used": ["mm-..."]
}
```

---

## 5. MemoryMaster Usage Contract

MemoryMaster should be read before architecture decisions and used as bounded
context for orchestration.

Use:

- `query_for_context(text, token_budget=...)` for task/event recall.
- `query_for_task(task_text, ...)` when active task metadata exists.
- `query_memory(text, limit=...)` for targeted facts and decisions.
- `federated_query(text)` only when cross-project/global recall is needed.
- `find_related_claims(claim_id, depth=...)` for follow-up graph traversal.
- `ingest_claim(...)` for durable decisions, constraints, bug root causes,
  integration gotchas, and test results.

Avoid:

- `list_claims` as context input except during explicit memory audits.
- Raw scrollback as durable memory.
- `search_verbatim` for templated orchestration streams, because templated
  content can collide in verbatim dedup. Prefer claim-level recall.

Scopes:

- `global` for system-wide facts.
- `user` for user preferences/workstyle.
- `project:<slug>` for project-specific claims.
- `team:<name>` for team-shared claims.

Every orchestrator/sentinel ingest must set a clear `source_agent`, e.g.
`codex-orchestrator-pane-33` or `claude-sentinel-pane-0`.

---

## 6. Human Tab vs Pane ID Problem

The user sees WezTerm tabs, not pane IDs. Pane IDs are monotonic and become
confusing after closing/reopening panes.

Required feature: expose a stable human mapping.

Candidate output:

```json
{
  "tab_index": 6,
  "pane_id": 5,
  "project_name": "memorymaster",
  "cwd": "G:/_OneDrive/OneDrive/Desktop/Py Apps/memorymaster",
  "title": "unified-agent-instruction-system",
  "status": "idle",
  "ctx": 95
}
```

Implementation options:

1. Extend `discover_sessions` to include `window_id`, `tab_id`, `tab_index`,
   `pane_index`, `is_active`, and normalized title.
2. Add a new `resolve_tab` MCP tool:
   `resolve_tab({ tab_index?: number, project?: string, title?: string })`.
3. Set explicit tab titles for important roles:
   `wezbridge-sentinel`, `codex-orchestrator`, `memorymaster`, `lifeagent`.
4. Maintain a small session alias registry in `vault/_wezbridge/pane-aliases.json`.

Acceptance: the user can say "tab 6 memorymaster" and the orchestrator can
resolve it to the correct pane without guessing.

---

## 7. Project-Ops Orchestrator Responsibilities

For each active project pane, the orchestrator should be able to ask:

- What is the product/app goal?
- Where are we on the roadmap or active task list?
- What changed recently?
- What is blocked?
- What should happen next?
- Does this need implementation, polish, audit, validation, release, or docs?
- Which local project-scoped skills exist and should be used?
- Should a `/goal` be created or updated for the pane?

Data sources, in priority order:

1. The target pane's own recap/status via A2A.
2. Project files: `AGENTS.md`, `CLAUDE.md`, `README.md`, `monitoring.md`,
   `active_tasks.md`, roadmap/PRD/checklist files.
3. Project-scoped skills under `.claude/skills`, `.codex/skills`,
   `.agents/skills`, and configured global skills.
4. MemoryMaster `project:<slug>` and relevant global/user claims.
5. Recent git status/log.
6. Browser/Playwright validation results when UI is involved.

Do not infer project direction from stale scrollback alone.

---

## 8. Skills And Validation

The orchestrator should know when to recommend or invoke skills, but it should
prefer asking the target project pane to run project-scoped skills when those
skills are local to that repo.

Important skill categories:

- Project setup/repair: `/project-setup`, `/project-doctor`,
  `/monitoring-setup`.
- Audit: audit orchestrator plus domain audit skills.
- UI/UX: `/ui-ux-pro-max`, `/frontend-design`, `/design-taste-frontend`.
- Visual validation: `/validation`, Playwright/browser-based checks,
  screenshots, actual app interaction.
- Workflow capture: `/skillify`.
- Payments/integrations: e.g. MercadoPago integration skill.
- Handoff/recovery: `/handoff`, `/clear`, auto-handoff.

Validation rule:

If a pane claims UI work is done, the orchestrator should push for actual visual
verification: run the app, use Playwright or browser MCP, capture screenshots,
review layout, then send findings back to the worker.

Tests rule:

Unit tests are not enough for frontend/user-facing changes. The default
definition of done should include:

- relevant unit/integration tests,
- browser or Playwright validation for UI,
- screenshot review when visual quality matters,
- MemoryMaster ingest for non-obvious findings.

---

## 9. "Knower Of All" Without Context Bloat

The orchestrator should become a router over knowledge, not the container of
knowledge.

Use a three-tier knowledge model:

1. Runtime state: pane list, tab aliases, active tasks, current goals.
2. Durable facts: MemoryMaster claims and wiki articles.
3. Deep history: session JSONL/verbatim logs, loaded only by a sidecar/subagent
   when explicitly needed.

If full session history is needed after compaction or pane restart, launch a
bounded reader task/subagent to summarize the relevant JSONL/session history
into a compact result. Do not paste full logs into the orchestrator.

---

## 10. Phased Implementation

### Phase 0 - Document and preserve the current decision

- Create this plan.
- Ingest the architecture decision and smoke test result into MemoryMaster.
- Keep old dashboard/orchestrator docs marked historical.

### Phase 1 - Smoke tests, no code changes

- Test cooldown/debounce with pane 0.
- Test a real target query: ask memorymaster pane "what do you need next?"
  using A2A and bounded MemoryMaster context.
- Test the current Codex orchestrator pane as a wake target. In this session,
  pane 33 is the orchestrator; do not spawn a second Codex pane as the
  canonical target.
- Verify Claude sentinel can read the Codex result and route it.

### Phase 2 - Pane/tab identity

- Extend discovery output or add a resolver for tab-visible identifiers.
- Add aliases for sentinel/orchestrator/known project panes.
- Document the operator convention for tab naming.

### Phase 3 - Sentinel event contract

- Define event packet schema for:
  `worker_idle`, `permission`, `ctx_high`, `task_done`, `telegram_dm`,
  `validation_failed`, `a2a_silent`.
- Add cooldown and dedupe by `(event_type, pane_id, task_id)`.
- Add allow/deny routing rules for destructive or expensive actions.

### Phase 4 - Project status probe

- Add a standard A2A request: "project status and next-step assessment".
- Require compact JSON response from target pane.
- Include roadmap/goal/test/audit/validation fields.
- Store the latest response in `vault/_wezbridge/project-status.jsonl`.

### Phase 5 - Goal dispatcher

- Let Codex propose `/goal` payloads.
- Claude sentinel asks user approval for long-running/expensive work.
- Target pane owns execution in its own repo.

### Phase 6 - Validation enforcement

- Add a post-completion validator route:
  worker says done -> orchestrator decides validation plan -> worker or
  verifier runs tests/browser checks -> findings return to worker.
- Prefer project-local validation skills and Playwright/browser MCP.

### Phase 7 - Skills curation

- Inventory local skills across `.claude`, `.codex`, `.agents`, and
  `claude-skills`.
- Decide packaging convention for audit skills, likely grouped under an
  `audit/` skill namespace while preserving slash compatibility.
- Compare local copies against `claude-skills` for updates:
  audit skills, handoff, MercadoPago, project setup/doctor/monitoring,
  skillify, validation.
- Avoid global promotion of project-specific skills.

---

## 11. Open Questions

- Should the always-on sentinel be pane 0 permanently, or should wezbridge
  spawn a named `wezbridge-sentinel` pane on boot?
- Should future Codex orchestrators be visible tabs, hidden panes, or spawned
  on demand? For this session, pane 33 is already the visible orchestrator.
- How much autonomy should the sentinel have before asking the user?
- What is the cooldown window for repeated idle events?
- Should tab aliases live in wezbridge state, WezTerm titles, or both?
- Should project panes be required to maintain `monitoring.md` before the
  orchestrator treats them as eligible?
- How should `/goal` state be synchronized with `active_tasks.md`?

---

## 12. Immediate Next Tests

1. Debounce:
   send a second `worker_idle` event to pane 0 within 60 seconds and require
   `decision: "do_not_wake"`.

2. Real project probe:
   ask pane 5 MemoryMaster:
   "what does memorymaster need next: roadmap, audit, validation, release, or
   no-op?" Require compact JSON.

3. Tab resolver:
   compare `discover_sessions` output to visible WezTerm tabs and define the
   minimal metadata needed to make "tab 6" addressable.

4. Codex orchestrator wake:
   reuse pane 33 and have pane 0 send it a compact event.
   Codex must return structured JSON visible to pane 0.

5. Validation loop:
   choose one UI project pane and run a dry "done -> validation required"
   decision without changing code.

# ROADMAP - Claude Sentinel + Codex Orchestrator

> Use this as the execution checklist for `/goal`.
>
> Source plan: `docs/PLAN-claude-sentinel-codex-orchestrator.md`.

---

## Goal

Build a small, tested local orchestration loop where a Claude sentinel pane
stays alive, detects project/pane events, wakes the Codex orchestrator pane with
bounded MemoryMaster context, and routes the resulting decision back to the
right project pane or to the user.

Current session convention: pane 33 is the Codex orchestrator. Do not spawn an
extra Codex pane just to have an "orchestrator"; disposable test panes are only
transport harnesses.

---

## Definition Of Done

- [x] Human-visible tab/project names can be resolved to wezbridge pane IDs.
- [x] Claude sentinel can debounce repeated events.
- [x] Claude sentinel can send compact A2A events to the actual Codex
  orchestrator pane.
- [x] Codex orchestrator can return strict JSON decisions.
- [x] At least one real project pane can answer a project-status probe.
- [x] MemoryMaster bounded recall is used for orchestration context.
- [x] No task relies on full scrollback or full claim dumps.
- [x] Completion/validation flow has a dry-run proof for one UI project.
- [x] Tests or smoke scripts document the expected behavior.

---

## Phase 1 - No-Code Smoke Tests

- [x] Prove sentinel wake path with synthetic `worker_idle`.
  - Result: pane 0 returned `decision: "wake_codex"` for
    `corr=sentinel-wake-smoke-20260516`.

- [x] Prove debounce.
  - Send a second `worker_idle` for the same pane/task inside 60 seconds.
  - Expected: `decision: "do_not_wake"`, reason includes `cooldown`.
  - Result: pane 0 returned `wake_codex` for
    `corr=sentinel-debounce-a-20260516`, then `do_not_wake` with cooldown
    for `corr=sentinel-debounce-b-20260516`.

- [x] Probe a real project pane.
  - Target: MemoryMaster pane.
  - Ask: current project status, roadmap position, blockers, next best action.
  - Expected: compact JSON, not prose.
  - Result: pane 5 returned compact JSON for
    `corr=memorymaster-status-probe-20260516`. Status was active, blocker was
    `context_high`, next action was handoff this session then resume v3.16+
    roadmap A1 once `ANTHROPIC_API_KEY` is in shell env.

- [x] Prove actual Codex orchestrator wake target.
  - Reuse the existing Codex orchestrator pane, currently pane 33.
  - Claude sentinel sends compact A2A event to it.
  - Codex replies with strict JSON visible to sentinel.
  - Previous result: a disposable Codex transport harness, pane 41, received
    valid A2A JSON for `corr=codex-wake-target-20260516b`.
  - Correction: that did not prove the real orchestrator path. Pane 41 was a
    mistaken extra pane and is not canonical.
  - Gotcha: `ctrl+c` exits an idle Codex TUI prompt; do not use it to clear
    starter text. Shell-quoted multiline JSON also mangled the first prompt.
    Use wezbridge `send_prompt` or another PTY-safe path.
  - Result: pane 0 sent
    `corr=actual-codex-wake-20260516` into pane 33. Pane 33 received the A2A
    request verbatim and replied with strict JSON:
    `{"ok":true,"decision":"wake_path_received","corr":"actual-codex-wake-20260516","a2a_wrapped_by_transport":false}`.
  - Caveat: pane 33 was working when the sentinel sent the request, so Codex
    queued it until the current turn boundary. Future sentinel sends must gate
    on `discover_sessions` reporting pane 33 idle before `send_prompt`.

- [x] Dry-run validation routing.
  - Pick one UI project pane.
  - Send synthetic `task_done`.
  - Expected: orchestrator decides whether visual validation is required.
  - Result: pane 0 returned `run_validation` for
    `corr=validation-routing-dryrun-20260516`, requiring Playwright/current
    bundle, console scan, DOM/screenshot evidence, and test-suite smoke.

---

## Phase 2 - Pane/Tab Identity

- [x] Inspect current `wezterm cli list --format json` fields.
- [x] Decide whether tab index can be derived reliably from WezTerm output.
- [x] Extend `discover_sessions` output with:
  - `window_id`
  - `tab_id`
  - `tab_index` if derivable
  - `pane_index` if useful
  - `is_active`
  - normalized `tab_title`
- [x] Add or document stable aliases:
  - `wezbridge-sentinel`
  - `codex-orchestrator`
  - `memorymaster`
  - `lifeagent`
  - Documented in `docs/PANE-ALIASES.md`.
- [x] Add `resolve_tab` or equivalent resolver.
- [x] Test: user phrase "tab 6 memorymaster" resolves to the expected pane.
  - Unit tests pass for tab index derivation, ambiguous matches, exact ID
    resolution, and title/project disambiguation.
  - Live check mapped MemoryMaster tab 6 to pane 5 and current Codex
    orchestrator tab `wezbridgecodex` to pane 33.
  - Restart the MCP server before expecting already-running clients to expose
    the new fields/tool.
  - Targeted verification: `node --test --test-reporter=spec
    test\pane-identity.test.cjs test\orchestrator-contract.test.cjs
    test\project-status-registry.test.cjs` passes 15/15.

---

## Phase 3 - Sentinel Event Contract

- [x] Define event JSON schema for sentinel-to-Codex requests.
- [x] Include event types:
  - `worker_idle`
  - `permission`
  - `ctx_high`
  - `task_done`
  - `telegram_dm`
  - `validation_failed`
  - `a2a_silent`
- [x] Add cooldown/dedupe rules by `(event_type, pane_id, task_id)`.
- [x] Add suppression reasons:
  - `cooldown`
  - `human_active`
  - `already_waiting`
  - `unsafe_action`
  - `missing_target`
- [x] Document the result schema Codex must return.

---

## Phase 4 - Project Status Probe

- [x] Create a standard A2A prompt template:
  - project goal
  - active roadmap/task
  - recent changes
  - blockers
  - next recommended action
  - validation/audit needs
  - relevant local skills
- [x] Require compact JSON response.
- [x] Store latest responses in `vault/_wezbridge/project-status.jsonl`.
- [x] Test with MemoryMaster.
- [x] Test with one UI-heavy project.
  - `personaldashboard` pane 3 returned compact JSON for
    `corr=personaldashboard-status-probe-20260516`.
  - Needed a second Enter after the A2A prompt was visible; prompt was not
    resent.
- [x] Test with one backend/integration-heavy project.
  - `whatsappbot-final` pane 2 returned compact JSON for
    `corr=whatsappbot-status-probe-20260516`.

---

## Phase 5 - MemoryMaster Integration

- [x] Define when the sentinel calls `query_for_context`.
- [x] Define when Codex calls MemoryMaster directly.
- [x] Add source-agent naming convention:
  - `claude-sentinel-pane-<id>`
  - `codex-orchestrator-pane-<id>`
- [x] Ensure every non-obvious decision/gotcha/test result is ingested.
- [x] Confirm no orchestration path uses `list_claims` as broad context.
- [x] Confirm templated event streams do not use `search_verbatim`.
  - Contract documented in `docs/ORCHESTRATOR-CONTRACT.md`.
  - Code helpers covered by `memoryRecallPlan` tests.

---

## Phase 6 - Goal Dispatcher

- [x] Decide how `/goal` state maps to `active_tasks.md`.
- [x] Let Codex propose a goal payload.
- [x] Sentinel asks user approval before dispatching long-running goals.
- [x] Target pane owns execution in its own repo.
- [x] Add A2A result handling for:
  - accepted
  - rejected
  - needs_user_input
  - completed
  - failed
  - Contract documented in `docs/ORCHESTRATOR-CONTRACT.md`.
  - Code helpers covered by `buildGoalDispatchPrompt` and
    `validateGoalDispatchResult` tests.

---

## Phase 7 - Validation Enforcement

- [x] Define when validation is mandatory.
- [x] For UI work, require:
  - app running,
  - Playwright/browser check,
  - screenshot review,
  - findings returned to worker.
- [x] For backend/integration work, require:
  - relevant automated tests,
  - smoke test or API check,
  - logs/error handling review.
- [x] Dry-run the full loop:
  worker says done -> orchestrator demands validation -> worker receives fixes.
  - Contract documented in `docs/ORCHESTRATOR-CONTRACT.md`.
  - Code helpers covered by `validationPlan`, `shouldRequireValidation`, and
    `buildValidationPrompt` tests.
  - Live dry-run:
    `corr=validation-enforcement-loop-20260516` sent validation findings from
    pane 33 to pane 3. Pane 3 acknowledged receipt and returned a concrete next
    worker action requiring same-bundle app health, Playwright authenticated
    walk, console scan, screenshot, and DOM evidence before claiming complete.

---

## Phase 8 - Skills Inventory And Curation

- [x] Inventory global skills.
- [x] Inventory project-scoped skills in active projects.
- [x] Compare local copies with `claude-skills`.
- [x] Decide packaging for audit skill family.
- [x] Review/update:
  - audit skills,
  - handoff,
  - MercadoPago integration,
  - project setup,
  - project doctor,
  - monitoring setup,
  - skillify,
  - validation.
- [x] Keep project-specific skills project-scoped.
  - Inventory and routing rules documented in
    `docs/SKILLS-INVENTORY-orchestrator.md`.
  - Gotcha: global `audit-loop` skill has invalid YAML and must not be routed
    until repaired.

---

## Suggested `/goal` Prompt

```text
Use docs/ROADMAP-claude-sentinel-codex-orchestrator.md as the execution
checklist and docs/PLAN-claude-sentinel-codex-orchestrator.md as the design
context. Start with Phase 1 only. Do not implement later phases yet.

Complete Phase 1 smoke tests end to end:
1. debounce repeated worker_idle,
2. real project status probe against MemoryMaster pane,
3. actual Codex orchestrator wake target,
4. dry-run validation routing.

Update the roadmap checkboxes as each item is verified. Ingest non-obvious
decisions/test results to MemoryMaster under project:wezbridge. Do not make
dashboard UI changes.
```

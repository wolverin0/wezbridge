# Codex Orchestrator Instructions

This file is for Codex sessions in this repo.

## Role

If you are pane 33 / tab `wezbridgecodex`, you are the Codex orchestrator for
the wezbridge local orchestration loop.

You are not the long-lived watcher. Pane 0 Claude is the sentinel. Your job is
to make compact decisions, maintain the roadmap/contracts, run tests, review
evidence, and route validated next actions.

## Canonical Docs

Read these before changing orchestration behavior:

- `docs/ROADMAP-claude-sentinel-codex-orchestrator.md`
- `docs/ORCHESTRATOR-CONTRACT.md`
- `docs/PANE-ALIASES.md`
- `docs/SKILLS-INVENTORY-orchestrator.md`
- `docs/a2a-protocol.md`

## Pane Roles

- `codex-orchestrator`: pane 33, this Codex session.
- `wezbridge-sentinel`: pane 0, Claude launched with the
  `wezbridge-sentinel.md` appended system prompt.
- Project panes own their own repository work. Do not silently edit another
  project from the central wezbridge pane.

## Operating Rules

- Use MemoryMaster bounded recall before architectural decisions.
- Prefer `query_for_context` or targeted `query_memory`; do not use broad
  `list_claims` as orchestration context.
- Treat context as layered, not cumulative. Global preferences live in global
  instructions/user memory, project rules live in project files, durable
  decisions/gotchas live in MemoryMaster, and active progress lives in roadmap
  or state artifacts. See `docs/MEMORYMASTER-PERSONAL-AI-HARNESS.md`.
- Ingest durable non-obvious findings with
  `source_agent='codex-orchestrator-pane-33'`.
- When sending A2A through wezbridge, always follow `send_prompt` with
  `send_key("enter")`.
- After sending A2A, verify delivery by reading the target pane tail. If the
  full envelope is still visible as unsent input, or if no response/progress
  starts, send a second submit key only. Do not resend the prompt body.
- Multiline A2A prompts are especially prone to Enter being treated as a
  newline by the target TUI. For long dispatches, keep the first line as the
  complete A2A header, keep the body concise, then read back and submit again
  if needed.
- When dispatching `/goal`, make it bounded: state the work, the measurable
  end state, and the constraints that must not be violated. Prefer the shape
  `/goal <work> until <verifiable end state> without <forbidden drift>`.
- Point long-running goals at a roadmap/checklist file and require the worker
  to update progress, tests, docs, and remaining gaps before completion.
- Before asking pane 0 to wake pane 33, make sure pane 33 is idle. If pane 33
  is working, the request can queue until the current Codex turn boundary.

## What Not To Do

- Do not spawn a second canonical Codex orchestrator pane.
- Do not revive the old browser dashboard/orchestrator-worker system.
- Do not treat pane IDs as stable user-facing names; resolve visible tabs and
  aliases through the pane identity helpers.

## Docs map

Doc triage map at `DOCS-MAP.md` (project root): every doc's verdict (CURRENT / SUPERSEDED / ABANDONED / GENERATED) and what replaced what. CURRENT docs carry a greppable 7-line header — grep heads before reading bodies; never base work on a doc the map marks superseded.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **wezbridge** (36245 symbols, 88686 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## When Debugging

1. `gitnexus_query({query: "<error or symptom>"})` — find execution flows related to the issue
2. `gitnexus_context({name: "<suspect function>"})` — see all callers, callees, and process participation
3. `READ gitnexus://repo/wezbridge/process/{processName}` — trace the full execution flow step by step
4. For regressions: `gitnexus_detect_changes({scope: "compare", base_ref: "main"})` — see what your branch changed

## When Refactoring

- **Renaming**: MUST use `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` first. Review the preview — graph edits are safe, text_search edits need manual review. Then run with `dry_run: false`.
- **Extracting/Splitting**: MUST run `gitnexus_context({name: "target"})` to see all incoming/outgoing refs, then `gitnexus_impact({target: "target", direction: "upstream"})` to find all external callers before moving code.
- After any refactor: run `gitnexus_detect_changes({scope: "all"})` to verify only expected files changed.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Tools Quick Reference

| Tool | When to use | Command |
|------|-------------|---------|
| `query` | Find code by concept | `gitnexus_query({query: "auth validation"})` |
| `context` | 360-degree view of one symbol | `gitnexus_context({name: "validateUser"})` |
| `impact` | Blast radius before editing | `gitnexus_impact({target: "X", direction: "upstream"})` |
| `detect_changes` | Pre-commit scope check | `gitnexus_detect_changes({scope: "staged"})` |
| `rename` | Safe multi-file rename | `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` |
| `cypher` | Custom graph queries | `gitnexus_cypher({query: "MATCH ..."})` |

## Impact Risk Levels

| Depth | Meaning | Action |
|-------|---------|--------|
| d=1 | WILL BREAK — direct callers/importers | MUST update these |
| d=2 | LIKELY AFFECTED — indirect deps | Should test |
| d=3 | MAY NEED TESTING — transitive | Test if critical path |

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/wezbridge/context` | Codebase overview, check index freshness |
| `gitnexus://repo/wezbridge/clusters` | All functional areas |
| `gitnexus://repo/wezbridge/processes` | All execution flows |
| `gitnexus://repo/wezbridge/process/{name}` | Step-by-step execution trace |

## Self-Check Before Finishing

Before completing any code modification task, verify:
1. `gitnexus_impact` was run for all modified symbols
2. No HIGH/CRITICAL risk warnings were ignored
3. `gitnexus_detect_changes()` confirms changes match expected scope
4. All d=1 (WILL BREAK) dependents were updated

## Keeping the Index Fresh

After committing code changes, the GitNexus index becomes stale. Re-run analyze to update it:

```bash
npx gitnexus analyze
```

If the index previously included embeddings, preserve them by adding `--embeddings`:

```bash
npx gitnexus analyze --embeddings
```

To check whether embeddings exist, inspect `.gitnexus/meta.json` — the `stats.embeddings` field shows the count (0 means no embeddings). **Running analyze without `--embeddings` will delete any previously generated embeddings.**

> Claude Code users: A PostToolUse hook DETECTS staleness after `git commit`/`git merge` and reminds you to re-run analyze — it does NOT reindex automatically (by design, to avoid blocking your commit). Run `npx gitnexus analyze --embeddings` yourself when the reminder fires.

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->

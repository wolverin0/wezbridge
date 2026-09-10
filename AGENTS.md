<!-- doc-head: Provider-independent orchestration custody and evidence contract -->
Scoped instructions; read for applicable authority, execution and verification rules.
<!-- /doc-head -->

# Wezbridge agent contract

## Role and custody

- The operator selects the orchestration agent. Resolve the live owner by project and verified pane identity; do not hardcode Claude/pane 0 or Codex/pane 33.
- The reasoning agent handles decisions and acceptance. The existing daemon owns durable wake delivery and missing-owner recovery; do not create another watcher per conversation.
- A launch profile selects a session/model for recovery only. It does not grant task, merge, deployment or credential authority.
- Project agents retain ownership of their repositories. Use isolated worktrees and declared ownership for changes; preserve shared uncommitted files.

## Read and execute

- Read `DOCS-MAP.md` before document bodies. For operation/recovery read `docs/operations.md`; for peer messages read `docs/a2a-protocol.md`.
- Use bounded MemoryMaster recall for architectural decisions. Check a relevant code index when useful; current code and runtime evidence resolve disagreements.
- Keep the current task in its existing roadmap and Fleet card. Use linked attempts for retries, not a second backlog or duplicated operator decision.
- Infer routine technical steps inside the user's authorized scope. Return questions only for a material unresolved decision, with evidence and a recommendation.
- Do not spawn subagents without explicit authorization. Existing peer tasks keep their recorded scope; do not widen it from a status message.

## Delivery and acceptance

- Prefer `a2a_send` and inspect its submission/delivery result. For raw `send_prompt`, follow the operator's current submission rule; never resend the body to repair an Enter.
- Verify the target project/pane and an available composer. Never type shell commands into an agent TUI.
- Track pending work across turns. Codex requesters poll outstanding peers at a bounded cadence; responders ACK, send progress and return a result with criteria, files_changed and next_action.
- Transport receipt is not acceptance. Open the referenced evidence and match objective, repository, revision and required criteria before accepting work.
- A failed, missing or contradictory mandatory criterion prevents closure. Preserve failure evidence and request bounded remediation.
- The implementation author does not independently approve their own change. Keep the review and origin-acceptance roles explicit.

## Verification and runtime

- `npm test` is the complete Node test command. It loads `test/setup.cjs`, which replaces WezTerm calls with the test double; use the same preload for focused tests.
- Focused example: `node --require ./test/setup.cjs --test test/pane0-watchdog.test.cjs`.
- `package.json` has no build script. Do not invent a build or browser gate for a change that has no such surface.
- `bridge_health` checks the live bridge. A listener, registration or launcher exit does not establish delivery, recovery or product completion.
- Changes on disk do not update a running daemon/MCP. Verify the loaded code and restart only the owning component when the task authorizes runtime activation.
- If GitNexus cannot resolve the actual symbol, record that limitation, inspect direct code references and test affected consumers. Never cite a result for a same-named symbol in another project as this change's impact.
- Do not revive retired ClawTrol/theorchestra systems or suspended jobs from historical documents.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **wezbridge** (72958 symbols, 202100 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

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

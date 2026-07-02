# MemoryMaster Personal AI Harness

This note maps the "personal AI system" idea from
https://x.com/heynavtoor/status/2055249160782389690 into the wezbridge
orchestration stack.

The useful pattern is not "put more context everywhere." The useful pattern is
layering: global preferences, project brains, durable memory, project files,
tool connectors, and scheduled routines each have a different job.

## Layer Map

| Source layer | Wezbridge equivalent | Storage |
| --- | --- | --- |
| Global personal preferences | User workstyle, tone, recurring constraints | `~/.codex/AGENTS.md`, user/global MemoryMaster claims |
| Separate projects | Per-repo agent behavior and project boundaries | `<repo>/AGENTS.md`, `<repo>/CLAUDE.md`, project docs |
| Memory | Durable decisions, gotchas, root causes, stable preferences | MemoryMaster claims with explicit scope |
| Voice/style | Communication and formatting preferences | Global instructions plus user-scoped MemoryMaster claims |
| Uploaded world | PRDs, roadmaps, specs, runbooks, state ledgers | Repo docs, `.vibecode/`, `.agentos/`, vault docs |
| Connectors/tools | Gmail, Drive, GitHub, wezbridge, browser, MemoryMaster | MCP/app/plugin configuration |
| Scheduled routines | Long-lived watcher, monitor loops, handoffs | Claude sentinel, `/goal`, A2A envelopes, project ledgers |

## Scope Rules

- Global/user memory is for stable preferences and cross-project workstyle.
- Project memory is for facts that should follow one repo or product.
- Project files are the source of truth for active work, roadmaps, checklists,
  reports, and verification evidence.
- Ephemeral pane state belongs in scrollback or A2A messages, not MemoryMaster.
- Sensitive content is never promoted across scopes.

## MemoryMaster Use

Use MemoryMaster to retrieve the smallest useful brief for the current task:

- `query_for_context`: bounded prose for watchdogs, dispatches, and handoffs.
- `query_for_task`: task-shaped recall when a roadmap item is active.
- `query_memory`: targeted fact lookup.
- `query_meta_decisions`: prior decisions only.
- `ingest_claim`: durable non-obvious decisions, gotchas, root causes, and
  verified outcomes.

Do not ingest:

- Full scrollback.
- Routine progress.
- Raw code snippets.
- Temporary worker status.
- Secrets, tokens, credentials, private IPs, or sensitive user data.

## Harness Implication

The orchestrator should ask one question before adding context:

> Does this belong in global instructions, project instructions, MemoryMaster,
> a project artifact, or only the current prompt?

If the answer is unclear, prefer a project artifact for active work and a
bounded MemoryMaster claim only after the fact becomes durable.


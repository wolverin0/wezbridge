<!-- doc-head: Read-only autonomy context and specialist inventory, 2026-09-07 -->
Bounded inspection of MemoryMaster Workflow Intelligence, scoped recall, Hermes provider, and infra/marketing/design/CRM contracts.
Includes measured existing census, evidence limitations, native specialist definitions and four LOW RISK evaluation specifications.
Read before choosing integration work; source, installed package, live MCP and historical reports are distinguished.
No ingestion, provider activation, repository edits, remote changes, messages, tests or evaluation jobs were performed.
<!-- /doc-head -->

# Verified inventory

Repository paths below are relative to the workspace project root unless stated otherwise. This report is the only authored file. Existing authoritative databases were not opened for modification; the workflow database was queried with SQLite `mode=ro` and `PRAGMA query_only=ON`. No raw transcripts, customer records or credentials were read for this report.

## MemoryMaster source, installation and analytics

- **Source:** `memorymaster` is on `main`, HEAD `b0dd976a32f8d29fb6ebf8257b4a9b8c5bcde700`, dated 2026-09-06, subject `docs: record verified 4.8.9 operational deployment`. Git status showed only untracked `delta-exchange/` and `repos/`; preserved. This is a local status observation, not a remote freshness claim.
- **Installed:** Python 3.12 distribution metadata reports MemoryMaster **4.8.9** in user-local site-packages. The user-local `memorymaster.exe workflow --help` actually ran, from `G:\tmp` with bytecode writing disabled. Entry points include `memorymaster`, `memorymaster-mcp`, `memorymaster-mcp-http`, `memorymaster-setup`, `memorymaster-session-end`, `memorymaster-steward`, `memorymaster-ops` and `memorymaster-workflow-hook`.
- **Live MCP:** one bounded `query_memory` call succeeded with `trust_mode=trusted`, `retrieval_mode=legacy`, `scope_allowlist=project:memorymaster`, explicit exclusion of candidate/conflicted/stale/sensitive content, and summary limit 4. The broad query produced weakly relevant claims; this proves callable governed recall, not useful task precision or current native Hermes operation.
- **Canonical docs:** `memorymaster/DOCS-MAP.md` marks `docs/workflow-intelligence.md`, `docs/governed-skills.md`, `docs/public-v1.md`, ADR 0016 and the Hermes scope/skills plan CURRENT. It marks the old `docs/integration/hermes-agent-brief.md` SUPERSEDED; that legacy SCP/cron brief was not used as authority. Current `ROADMAP.md:31` records native Hermes adoption; runtime revalidation belongs to the Hermes inventory.

### Existing baseline: census only

The existing report `%USERPROFILE%/.memorymaster/reports/workflow-intelligence/20260831T192739Z/report.json` was generated **2026-08-31T19:27:39.389803+00:00**, without scope/date filters. Its aggregate counts match a fresh read-only query of the current workflow sidecar:

| Measure | Existing measured count |
|---|---:|
| Source files | 20,064 |
| Indexed sessions | 15,444 |
| Human root sessions | 13,650 |
| Subagent sessions | 1,794 |
| Automation sessions | 0 |
| Claude sessions | 12,021 |
| Codex sessions | 3,423 |
| Deep-parsed sessions | 0 |
| Scan runs | 1 |
| Turns / actions / feedback / episodes | 0 / 0 / 0 / 0 |
| Candidates / reviews / completion receipts | 0 / 0 / 0 |
| Unknown completion states | 15,444 |

**No intervention rate, retry rate, success rate, closure rate, time saved or human coordination baseline can be calculated from this dataset.** The report's zero corrections, retries, research violations and A2A closures are unmeasured due to zero deep parsing, not evidence of absence. Every verification tier is `none`. The `unclassified_sessions=0` report field also must not be treated as meaningful classification coverage when all completions are unknown and no sessions were deep parsed.

No eligible warning sample exists for shadow-receipt precision. The source gate requires 14 days, 100 receipts, at least 20 from each provider, reviewed warnings, precision >=90%, and zero read-only false positives; even a passing gate would not activate advisory mode. No receipt hook activation was attempted.

### CLI side effects

`memorymaster/surfaces/cli_handlers_workflow.py:20-50` registers the following commands; installed help confirms the same surface:

| Command | Actual boundary |
|---|---|
| `workflow --help` | Argparse exits before store/service creation; executed safely. |
| `scan [--deep none|human|selected] [--session ID]` | Indexes sources; human or selected modes parse transcripts and write analytics. Not run. |
| `inspect ID` | Reads normalized rows after opening an initializing store. Not run. |
| `classify --limit N` | Opt-in provider call plus persisted classification. Not run. |
| `report --scope ... --since ... --output ...` | Writes HTML/JSON reports. Not run. |
| `candidates [--status ...]` | **Refreshes candidates and writes**, despite list-like help. Not run. |
| `review`, `receipt-review` | Persist review labels. Not run. |
| `proposal --output ...` | Writes an inert proposal file. Not run. |
| `shadow-status` | Computes the gate after opening an initializing store. Not run. |

Every dispatched workflow command creates `WorkflowStore`; `storage.py:214-227` makes directories, executes schema and commits. Therefore these are not strictly read-only inspection interfaces. `candidates` explicitly invokes `refresh_candidates` (`cli_handlers_workflow.py:79`). Public report redaction and inert proposal governance are implemented; the sidecar remains disposable, separate from governed memory. V1 intentionally provides no new scheduler, MCP server, dashboard, transcript embeddings or automatic instruction activation.

### Intervention categories and safe historical spotchecks

Source taxonomy (`workflow_intelligence/adapters.py:28-39`) recognizes research-before-editing, missing verification, ignored instructions, misunderstood scope, overengineering, premature stopping, plus generic correction signals. The named phrase matchers are predominantly English; the operator's Spanish corrections need an explicitly labeled sample before claiming taxonomy coverage. This is a source limitation inference, not a measured false-negative rate.

For real intervention examples without transcript access, the CURRENT curated `marketing/knowledge/failure-archaeology.md` records:

| Existing evidence | Coordination category | Recorded enforcement / implication |
|---|---|---|
| `:19`: dated wrong-contact incident affecting 16 creatives | Wrong source / unresolved placeholder used as truth | Canonical contact source plus blocking `[REVISAR]` and QA number guard. No contact value reproduced. |
| `:21`: apparent transparency accepted without real alpha | Unsupported success claim | Check image mode and alpha, instead of trusting a visual checkerboard. |
| `:27`: the same safe-zone overlap reported 10 times | Repeated operator correction / missing acceptance guard | Canonical compositor plus deterministic format-aware safe-zone check; old generator archived. |
| `:37`: session-bound campaign cron expired silently | Lost durable job / missing supervision | Existing watchdog and durable task mirror, with validity checks. No spending or scheduler changes here. |

These are **four selected historical documentation examples**, not four independently audited root sessions and not a present-day intervention denominator. Counts 16 and 10 are the document's dated incident figures, not newly reconstructed analytics. They justify evaluating better scoped context, durable work ownership and concrete acceptance. They do not justify automatic promotion of new lessons.

## Scoped approved context: existing integration surfaces

Use the existing MCP instead of creating a duplicate memory layer:

- `mcp__memorymaster__recall`: parameters include `query`, `scope_allowlist` (string through MCP), `workspace`, `trust_mode`, `retrieval_mode`, `token_budget`, `include_skills`, `skill_limit`, optional observations and session/source-agent fields. For task injection: exact project allowlist, `trusted`, `legacy`, bounded token budget, `include_skills=true`, limit <=3, observations off unless explicitly needed. Confirmed, active authorized skills are separate from ordinary claims.
- `query_for_context`: supports the same explicit trust/sensitivity and candidate/stale/conflict filters, summary/full detail and bounded token output. Useful for bounded task context; broad keyword recall is insufficient evidence of useful precision.
- `query_for_task(task_description, project_scope, token_budget, workspace, skip_qdrant)`: existing task-briefing wrapper. Its narrower parameter surface means acceptance should still verify returned scope and evidence.
- `skill_recall(query, scope_allowlist, limit, workspace)`: confirmed active authorized skill recall only.
- `session_scope_show`: read-only bounded scope metadata. `session_scope_bind`/`clear` exist but are mutations and were not invoked.
- Public Python facade `memorymaster.recall(...)` (`public/v1.py:387+`) defaults to trusted and takes a list/tuple `scope_allowlist`; do not confuse Python and MCP parameter types.

Reusable task context should consist of the target's applicable instructions, CURRENT map-selected docs, a small set of cited approved claims/skills, and task-specific acceptance evidence. Historical analytics, raw excerpts, generated profiles and peer statements do not grant authority. Source and runtime resolve stale memories.

### Existing Hermes native integration

`memorymaster/integrations/hermes-memorymaster` is an existing companion implementing the native external **MemoryProvider ABI**, without editing Hermes core. Its source supports:

- Authenticated streamable MCP HTTP authority at the endpoint supplied through `MEMORYMASTER_HERMES_MCP_URL`; standard path `/mcp`. The token is supplied through `MEMORYMASTER_HERMES_MCP_TOKEN`; no endpoint value or credential was read for this inventory.
- Install preview then explicit installation of three shim files under `$HERMES_HOME/plugins/memorymaster/`, followed by Hermes provider selection. The README's pinned ABI caveat says a general pip plugin entry point could not register exclusive providers, hence the user-provider directory.
- `sync_turn()` commits sanitized, hashed-identity turns into `memorymaster-outbox.db`; a worker performs bounded retry/backoff with auth/scope errors blocked. Source defaults: 1,000 pending items, 16 MiB, five attempts, 350 ms recall timeout and 120 s recall cache (`config.py:34-53`).
- `prefetch()` is non-blocking/cache-backed. Configured replica fallback is strictly recall-only. Authoritative and replica recall both request approved skills, limit 3 (`backend.py:94-106,208-222`).
- Native tools include `memorymaster_recall` and `memorymaster_scope`; explicit session binding precedes project writes. `default_scope` permits `user` or `project:<slug>` and forbids `global`. Memory removal remains preview-only.

This is **source-confirmed integration**, with the current roadmap recording adoption. This subtask did not prove installed plugin selection, active Hermes process identity, outbox drain, live HTTP auth, service restart recovery or actual context injection; root's Hermes runtime investigation must supply those facts. A local `hermes.cmd` launcher exists and targets a user-local Hermes virtual environment.

## Specialist contracts already present

| Domain | Trusted context entry and scope | Existing native definitions | Acceptance and authority boundaries |
|---|---|---|---|
| Engineering / MemoryMaster reference | `AGENTS.md`, `DOCS-MAP.md`, current roadmap; authoritative SQLite versus derived analytics | Public disposable lifecycle demo + tests; no new specialist definition needed for the reference task | Capture/cited recall/retirement must show artifacts; no authoritative DB as test fixture; source-tested, installed and live-verified are distinct. |
| Infra | `infra/AGENTS.md`; `PLACEMENT.md` ownership/location map; `SYSTEM.md` system of record; `docs/DOCS-MAP.md`; bounded relevant `CROSS-PANE-STATUS.md` | Shared tool-independent commander contract; no `.claude/agents` definitions observed in bounded inventory | Read-only audits; capture reversal data before changes; protect other project owners; prove real backup contents/offsite sync, not process exit; no duplicate system-of-record. `SYSTEM.md` headings show current runtime corrections newer than generic instructions. |
| Marketing | `marketing/AGENTS.md` + `CLAUDE.md`, `.claude/rules`, `DOCS-MAP.md`, `registry.md`, target `.marketing/brand.md` and `product.md` | `.claude/agents/{content-creator,ad-creative,seo-strategist,market-researcher,competitive-analyst}.md` | No product-code edits. es-AR/voseo and truthful HAVE-only claims. Render -> deterministic QA -> visual read -> proposed queue. No publish from creative generation; paid ads paused absent campaign authority. Draft-only mission overrides any broader historical publishing role. |
| Frontend design | `frontendesigner/CLAUDE.md`, `.claude/rules`, `DOCS-MAP.md`, `registry.md`, target `.design/{PRODUCT,DESIGN}.md` or existing `projects/<name>.md` | `.claude/agents/{design-reviewer,a11y-perf-auditor,mockup-generator}.md` | Presentation layer only; no backend/schema/auth/secrets; mockup/diff before rewrite. Reviewer explicitly reads/reports without editing. A11y specialist specifies screenshots at 390/768/1280, keyboard/contrast/reduced-motion and measured evidence. |
| CRM | `crm/AGENTS.md`, `CLAUDE.md`, latest relevant `memory/handoff.md`, `.claude/rules/saleor-ops.md`, map-selected approval-queue handoff | Shared workflow and Saleor storefront skill; no `.claude/agents` definitions observed | Live ISP service exclusions; Saleor remains catalog/pricing/orders authority, downstream data read-only/uncached. CRM records proposal approval; publishing is an external agent flow. June queue handoff is specification, not current runtime verification. |

These are real domain contracts and Claude-native specialist definitions. They are **not verified Codex/Hermes profiles**. Reuse their substance through each runtime's supported profile/context mechanism; do not assume filename compatibility. Some specialist tool declarations are broad (`All tools`, Bash). A LOW RISK evaluation should constrain actual runtime tool access and task write roots, not rely on prose alone.

Two drift examples argue for scoped source selection: marketing registry status is dated July and includes product claims broader than its narrower AGENTS HAVE-only example; infra shared instructions describe manual Coolify deployment while newer SYSTEM sections describe push-triggered deployment. Neither should be resolved by blindly concatenating all files. Read the exact current target contract and runtime only when its verification is authorized.

## Four representative LOW RISK evaluations (specifications; not executed)

1. **Engineering disposable reference task.** In an isolated scratch checkout/profile, run the existing MemoryMaster disposable public lifecycle demonstration and a small independent acceptance check based on `tests/test_public_demo.py:16-39`. Inputs are synthetic; require capture, cited trusted recall, retirement exclusion and `temporary_database_disposed=true`. Author an evidence receipt with exact command/version, pass/fail per criterion and no live DB path. This exercises owned engineering work and concrete acceptance without modifying product source or authoritative memory. For a mutation exercise, perturb only the copied synthetic reference expectation, prove failure, then restore and prove pass; label it a rehearsal.
2. **Infra read-only proof triage.** Read only the backup/schedule sections of CURRENT `SYSTEM.md` plus mapped runbook and a specifically supplied already-redacted job artifact. Return a table separating configured schedule, last evidenced natural run, payload verification and offsite verification; unknown fields stay unknown. Acceptance: every status cited to a file/line/artifact timestamp, no inferred success from registration/exit, no SSH, scheduler trigger, restart, backup, config write or network change. If no eligible artifact is supplied, artifact-level criteria are `not measured`, not passed.
3. **Marketing draft.** From the FuturaCRM registry pointer and target `.marketing/brand.md` + `product.md`, produce one local draft with hook, short caption, CTA and visual brief, grounded in verified HAVE-only claims. Use the existing content-creator contract with es-AR/voseo; omit prices/contacts unless supplied as approved task facts. Acceptance: each feature claim linked to brand evidence, correct locale, explicit draft state, no invented testimony/metrics/screenshots, no queue/upload/publish/spend. Missing or contradictory brand facts yield a narrower draft with the ambiguity recorded, not a request to launch.
4. **Design acceptance.** Have `design-reviewer` plus the a11y rubric inspect an existing sanitized local preview or supplied synthetic fixture at 390/768/1280, using its task-local PRODUCT/DESIGN context. Return prioritized issues with element, severity, screenshot/DOM evidence and concrete fix; include keyboard traversal, focus visibility, contrast and reduced motion. Acceptance is an independently reviewable diagnosis, not self-approved product delivery. No code rewrite, backend/auth change, remote publish or external screenshot upload; unavailable browser/performance evidence is explicitly unmeasured.

For all four, record assigned owner, exact permitted reads/writes, explicit exclusions, required artifacts, timeout/retry policy and final acceptance reviewer. Keep one durable job identity across retries; a result receipt is transport evidence until its mandatory criteria and artifact revision are checked by the accepting role. No coordination-reduction claim is available until a before/after sample actually measures operator interventions and completed work under comparable scopes.

## Limitations and next integration decisions

- Analytics ingestion remained off for this inspection; the retained census cannot answer the requested intervention baseline. A future separately scoped, bounded human-root deep sample plus manual labels is necessary. Do not launch a whole-history parse as a default.
- This inventory inspected native definitions and current instruction sources, not all projects, all rule bodies, raw history or customer material. No filesystem-wide scan and no remote service probes were made.
- No new ingestion, memory claim, skill proposal, active profile, hook, scheduled job, external message, queue proposal, repository edit or deployment occurred. Local docs/maps were read before relevant bodies; existing files were preserved.
- Evidence supports integrating already existing scoped recall and specialist contracts. It does not support an additional watcher, second memory authority, automatic policy activation or a numerical autonomy benefit yet.

Memory lookup used `MEMORY.md:111-163` only as historical routing context for Workflow Intelligence; source/install/report facts above were refreshed. Related prior rollout ID: `01a054aa-0542-7701-b03f-6614b3bc239d`.

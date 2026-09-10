<!-- doc-head: Archived August 2026 software-factory research, not runtime authority -->
Dated sources, interpretations and project comparisons preserved during September consolidation.
Read for historical design context; verify current code and decisions before adopting recommendations.
<!-- /doc-head -->

# 04 — What transfers to Snake's factory

## Current baseline

Snake already has the essential layers the post argues for:

- **Conversation/operator layer:** Hermes Telegram gateway + Desktop + profiles.
- **Durable cross-session knowledge:** MemoryMaster; it remains the authority rather than copying facts into each bot.
- **Cross-pane execution:** WezBridge/WOLVERIN0 panes.
- **Specialized fleet:** `main`, `dev`, `self-audit`, `leads`, `bot-hr`, `wisp-dev`, `research`, `meta`, plus legacy/domain profiles.
- **Browser verification:** browser-use/agent tools and Playwright-capable workflows.
- **Existing rule/skill structure:** scoped `AGENTS.md`, skills, plans and runbooks.

The gap is **not** "build another factory." It is making the existing pieces explicit, measurable and non-duplicative.

## Adopt, adapt, reject

| Hraness idea | Decision | Why / adaptation |
|---|---|---|
| Durable Markdown + Git knowledge beside repos | **Adapt** | MemoryMaster is already cross-project durable authority. Per-repo plans, evidence and `AGENTS.md` should remain inspectable local artifacts; do not create a rival global KB. |
| QMD + local embeddings | **Evaluate later** | Useful if repository/local-doc retrieval is demonstrably weak. First measure whether MemoryMaster + ripgrep/file search misses relevant material. |
| Strong scoped prose/rules | **Adopt selectively** | Keep operational rules short/scoped and write rationale/evidence in plans or KB. A separate `WRITING.md`/`STYLE.md` is useful only for content-heavy products. |
| Direct deterministic application state | **Adopt for products with expensive/fragile setup** | Pair with real browser E2E. Do not report deterministic-fixture coverage as proof of external integrations. |
| agent-browser/Playwright verification | **Adopt / standardize** | This matches the need for browser-visible evidence. Give each product a small set of critical user flows and failure-state checks. |
| Wrench capability/custody model | **Adopt principles, evaluate tool** | Its named capability, account binding, fail-closed drift, receipt and explicit-confirmation concepts match Hermes safety boundaries. Do not install it just to duplicate browser/MCP tools. |
| Multi-account metaharness | **Adapt only with authorized, genuinely separate capacity** | Hermes/WezBridge already provide multi-agent routing. Duplicate profiles do not create capacity. Account pooling must respect provider terms, data scope and auditability. |
| Unattended days-long agents | **Reject as a goal** | Use bounded jobs, checkpoints, time budgets, monitoring, ownership and recovery. Duration without proof is failure amplification. |
| "Continual learning is solved" | **Reject** | Durable context still needs source freshness, conflict handling, deterministic gates, reviews and explicit ownership. |
| Token leaderboard / maximum consumption | **Reject as KPI** | Measure completed verified work, incidents avoided, turnaround, real business outcomes and cost—not token burn. |
| Autonomous investment execution | **Reject for this operating model** | Finance mutations require explicit, payload-bound approval and independent reconciliation. |
| Contact graph across private sources | **Defer / privacy-first** | High-value but high-risk. Establish consent, data minimization, retention, source separation and outbound controls first. |

## The strongest counterpoint: the software-factory trap

[dhasandev's critique](https://x.com/dhasandev/status/2057519809017897061) does not reject agents; it rejects treating code generation as the bottleneck. Its useful standard is a **reviewable derivation packet**: task intent, authoritative sources, assumptions, implemented slice, exact evidence, independent verifier verdict, and what becomes stale if source conditions change.

For Snake, that means every nontrivial fleet result needs a durable receipt outside the pane: owned task, bounded context, claimed effects, commands/read-backs/browser proof, and an explicit outcome state. Green cron/scheduler status and agent self-reports are insufficient. This reinforces—not replaces—MemoryMaster as durable authority, repo-local evidence as code-context proof, WezBridge as transport, and Hermes as execution/operator layer.

## Recommended first implementation: verification harness, not another orchestrator

### Objective
For each active product, make a compact declaration of **what an agent may verify, how it reaches the state, and what constitutes evidence**.

### Minimum contract per project

```md
# Product verification contract

## Critical flows
- authenticated primary task
- representative error/empty state
- payment/customer-impacting path (read-only unless separately approved)

## State source
- real integration | deterministic scenario | mixed

## Evidence
- browser assertion/screenshot
- API or database read-back
- deployment/runtime health evidence

## Owner
- named bot/profile

## Failure path
- stop, record result, surface to Meta; never silently retry a mutation
```

This gets the useful part of Direct's philosophy immediately, whether or not Direct itself is adopted.

## Recommended fleet roles after consolidation

- `meta`: reads the contracts/receipts and reports missing owner, stale source, failed routine or no-reader conditions. It should not execute customer or finance actions.
- `self-audit`: periodically tests the integrity of the Hermes/WezBridge/MemoryMaster paths and the evidence claims made by other bots.
- `dev`: adds/repairs product verification harnesses.
- `research`: compares tools such as QMD, Direct, Wrench and HRA against a bounded acceptance test—not hype.
- `leads`, `bot-hr`, `wisp-dev`: domain workflows only, subject to their existing external-action boundaries.

## A safe 30-day sequence

1. **Week 1 — inventory:** one canonical roster, one owner per routine, source/output/reader/quiet condition for every job.
2. **Week 2 — evidence:** add 2–3 critical browser/API verification flows to one selected product; demonstrate one failure is detected and routed.
3. **Week 3 — retrieval:** measure specific unanswered repository-context queries. Only then pilot QMD/local retrieval against a small corpus.
4. **Week 4 — custody:** evaluate Wrench-like capabilities for one read-only connected service; require exact account binding, receipt and drift handling before considering writes.

## Decision gates

Do not purchase subscriptions, install broad browser credentials, connect brokerage/contact sources, or add unattended write workflows merely because the post makes them look efficient. Each requires a separate scope, owner, approval boundary and rollback/reconciliation plan.

<!-- doc-head: Archived August 2026 software-factory research, not runtime authority -->
Dated sources, interpretations and project comparisons preserved during September consolidation.
Read for historical design context; verify current code and decisions before adopting recommendations.
<!-- /doc-head -->

# 01 — Source map and claim ledger

## Primary item

- **Author:** Hraness / Ben Guo (`@hraness`)
- **Post:** [Building a software factory](https://x.com/hraness/status/2090680065528901919)
- **Published:** 21 Aug 2026, 05:59 UTC (as recovered from X)
- **Form:** a long X article/thread-style post with five steps, a named stack, and a list of personal agents/projects.

## The five-step argument

| Step | Author's point | Mechanism named | Evidence status |
|---|---|---|---|
| 1. Best tokens efficiently | Use the best model on the capability/price frontier; extract value from subscription plans. | AI Charts, SemiAnalysis estimate, Codex App Server, HRA. | Model-selection tools and Codex App Server are verified; subsidy/value maths remains an author interpretation. |
| 2. Knowledge base | Agents need durable, searchable context across sessions. | Markdown + SQLite + Git, QMD, EmbeddingGemma. | The technical pattern and QMD/EmbeddingGemma exist. "Continual learning is solved" is not established. |
| 3. Improve writing | High-quality instructions/prose improve agent output. | `WRITING.md`, `STYLE.md`, root `AGENTS.md`. | A design recommendation, not a quantified result. |
| 4. Solid stack + verification | Simpler stack and agent-verifiable UI states enable long-running work. | Direct, Wrench, agent-browser/Playwright. | Direct/Wrench/agent-browser are verified public projects. Their claimed factory impact is author-reported. |
| 5. Let agents cook | Specialized bots own useful personal workflows. | Read, Wrench, Invest, Stripe, News, Atet, People, SEO, Act60. | The author names functions; several underlying projects are public, but individual bot autonomy/outcomes are not independently verified. |

## Claims that need careful reading

### Subscription/value arithmetic

The author says 15 Codex Pro 20x subscriptions cost $36k/year and represent a $2.5M annual premium-inference run rate using a 70× subsidy assumption. A June SemiAnalysis-style usage comparison is widely cited for high API-equivalent value of fully utilized premium plans, but that is **not cash value**, not a guarantee of continued entitlement, and not a sustainable inference-cost forecast. [SemiAnalysis reporting summary](https://pasqualepillitteri.it/en/news/4793/semianalysis-token-value-claude-chatgpt-plans) describes the methodology and its assumptions; use it as a pricing-risk signal, not an ROI calculation.

### "Continual learning is solved"

The post's statement is an architectural opinion. Durable notes, retrieval, task handoff, and agent coordination solve a large part of **context continuity**. They do not by themselves solve stale facts, conflicting decisions, schema drift, unsafe tool authority, evaluation, or ownership. See [04 — fit for Snake](04-fit-for-snake.md).

### Long-running agents

"Hours or days" is not success evidence by itself. A safe interpretation is: work should be **checkpointed, bounded, observable, and recoverable**. The post's best supporting mechanisms are Direct's deterministic state and Wrench's fail-closed/custody design—not duration.

## Reply/reply-thread recovery

Visible replies recovered with the post:

1. `@dhasandev`: links/references [The Software Factory Trap](https://x.com/dhasandev/status/2057519809017897061), recovered independently. Its argument is that the bottleneck is not generating code but producing a reviewable derivation packet: authoritative sources, assumptions, scoped specification, proof and staleness/invalidation links.
2. `@dhasandev`: "hraness builds a harness." A characterization, not evidence.
3. `@jeffweisbein`: links [openclaw-starter-kit](https://github.com/jeffweisbein/openclaw-starter-kit) and includes an analysis. It supports three transferable themes: provider-account operations, user-visible verification, and richer repository-aware knowledge. It also rejects blindly copying a separate factory. The starter kit itself is covered in [02](02-factory-primitives.md).

## Resource topology

```text
Frontier model access / accounts
  └─ Codex App Server → HRA orchestration

Repository knowledge
  └─ Markdown + Git + SQLite → QMD + EmbeddingGemma retrieval

Rules and prose
  └─ AGENTS.md + plans + style guidance

Reliable application changes
  └─ Direct deterministic state + agent-browser/Playwright UI actions

Custody-aware web capability
  └─ Wrench bounded operations / evidence / explicit confirmation

Specialized personal agents
  └─ Read, News, SEO, People, Invest, Atet, Act60, etc.
```

The critical distinction: browser control, deterministic state, durable knowledge, tool custody, and agent orchestration are **separate layers**. The post does not claim one tool does all of them.

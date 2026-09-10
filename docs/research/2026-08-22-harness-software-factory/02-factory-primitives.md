<!-- doc-head: Archived August 2026 software-factory research, not runtime authority -->
Dated sources, interpretations and project comparisons preserved during September consolidation.
Read for historical design context; verify current code and decisions before adopting recommendations.
<!-- /doc-head -->

# 02 — Factory primitives and technical resources

## 1. Model choice, access, and orchestration

### [AI Charts](https://aicharts.io/) — model/agent comparison interface
- **What it is:** a browser-based AI model and agent comparison/chart site; the public page is JavaScript-rendered.
- **Role in the post:** the author's claimed way to identify a capability/price Pareto frontier before choosing a coding model.
- **What it does not establish:** an objective universal ranking or a subscription-adjusted cost calculation. Benchmarks, latency, provider availability, and tool reliability are task-specific.
- **Factory lesson:** keep a short, periodically validated model-routing benchmark for *your* tasks; do not select by a generic leaderboard alone.

### SemiAnalysis subscription-value claim — external economic reference
- **Recovered context:** reporting about a June 2026 SemiAnalysis experiment says it exhausted paid Anthropic/OpenAI plans with long-horizon agentic coding and converted measured tokens to API list-price equivalents. [Summary](https://pasqualepillitteri.it/en/news/4793/semianalysis-token-value-claude-chatgpt-plans)
- **Role in the post:** foundation for the author's 70× subsidy framing.
- **Caveat:** the recovered linked source is [SemiAnalysis post 3/4](https://x.com/SemiAnalysis_/status/2064815045767213400), so its full thread methodology was only partially recoverable. The 70× headline is a maximum API-list-price-equivalent comparison and uses stated gross-margin assumptions; it is neither a promise of capacity nor a reason to create duplicate identities.
- **Factory lesson:** measure actual success rate, queueing, failure modes, and account policy—not inferred "token value." 

### [Codex App Server](https://developers.openai.com/codex/app-server) — Codex control protocol
- **What it is:** OpenAI's experimental JSON-RPC control surface for Codex. It supports stdio by default and experimental WebSocket/Unix-socket transports; it streams thread/turn events and supports rich client integrations.
- **Role in the post:** the author built a CLI over it to track multiple Codex accounts and uses it as a substrate for HRA.
- **Caveat:** official docs say the app-server/WebSocket path is experimental and unsupported for production workloads. Do not make it the only durable controller without recovery and version pinning.

### [HRA](https://hra.sh/) / [source](https://github.com/hraness/hra) — multi-subscription Codex metaharness
- **What it is:** a public-pre-release macOS (Apple Silicon) coordinator for authorized, separate Codex accounts. It keeps task graph, ownership, review, and recovery state outside individual conversations.
- **Role:** demonstrates the extra layer above parallel tabs: dependency-aware delegation, managed worktrees, account isolation, and restart recovery.
- **Important limit:** HRA says it does not bypass provider limits or move work across accounts; it is intentionally Codex-specific and local-authority-first.
- **Relation to the rest:** HRA orchestrates **agents/accounts**; it does not replace knowledge retrieval, UI verification, or secure web capabilities.

## 2. Durable knowledge and retrieval

### [hraness/kb](https://hraness.com/kb) — repository-adjacent agent knowledge pattern
- **What it is:** a small-file contract: scoped `AGENTS.md` rules beside a versioned Markdown vault (`articles/`, `notes/`, `plans/`, `index.md`). It keeps code from importing the KB or surrendering records to a hosted graph database.
- **Role:** the conceptual center of Step 2. Rules govern edits; notes preserve rationale/evidence; plans preserve decisions/outcomes.
- **Key distinction:** the KB is the authoritative write/read corpus; search is a replaceable retrieval layer.

### [QMD](https://github.com/tobi/qmd) — local hybrid document search
- **What it is:** a local Markdown/text search engine using keyword search, vector search, query expansion and reranking; it can expose an MCP server.
- **Role:** optional retrieval layer once plain Markdown/Git/index search no longer answers agent questions well.
- **Relation:** QMD indexes the durable KB; it should not become an opaque second source of truth.
- **Operational caveat:** local model downloads and index rebuilds add disk/RAM/latency requirements. Start with simple file search and add it only when retrieval quality is a measured bottleneck.

### [EmbeddingGemma 300M](https://huggingface.co/google/embeddinggemma-300m) — local embedding model
- **What it is:** Google's 300M-parameter open embedding model (license acceptance applies on Hugging Face).
- **Role:** the local semantic-vector layer described by the author for QMD.
- **Caveat:** embedding quality, chunking, metadata, and evaluation determine retrieval usefulness more than model choice alone. Model availability is subject to its license/terms.

## 3. Deterministic product verification

### [Direct](https://hraness.com/direct) / [Todo example](https://github.com/hraness/direct/tree/main/examples/todos)
- **What it is:** a deterministic-state harness for a product's development composition. It supplies named scenario worlds, routes, controllable time, readiness, reset and a machine-readable manifest.
- **What it is not:** a browser driver or proof that replaced/live systems work.
- **Role:** solves the slow setup problem—particular account/data/error/device/model states—so an agent can reliably reach a UI state before using browser automation.
- **Correct composition:** Direct supplies deterministic *state*; [agent-browser](https://agent-browser.dev/) or Playwright supplies browser *actions/assertions*; real integration/E2E checks cover the systems Direct replaces.
- **Critical invariant:** unknown requests fail visibly rather than silently reaching live services. This prevents a fixture test from masquerading as an integration test.

### [agent-browser](https://agent-browser.dev/) — agent-first browser automation
- **What it is:** a Rust CLI/daemon for browser automation, accessibility snapshots with stable refs, screenshots, session state, network/debug tools and native binaries across major desktop OSs.
- **Role in the post:** inspiration for Wrench's `derive-client` concept and an example of efficient browser control.
- **Where it fits:** UI exploration and verification. It does not supply product fixture states, custody of authenticated actions, or orchestration.

### Playwright — standard browser automation reference
- **Role in the post:** interchangeable broad category with agent-browser for browser interactions.
- **Where it fits:** real browser workflows, app assertions, and live E2E coverage. Pair with deterministic state only when setup dominates; otherwise it is the smaller tool.

## 4. Web capabilities, custody, and side effects

### [Wrench](https://wrench.rip/) / [source](https://github.com/hraness/wrench)
- **What it is:** an MIT-licensed CLI/TypeScript SDK (macOS/Linux) that exposes small named operations: URL capture, authorized media archive, encrypted account-bound reads, and reviewed account operations.
- **Role:** a custody/capability layer beneath an agent framework. It deliberately keeps browser sessions, credentials, provider plumbing and selectors behind typed, bounded operations.
- **Why it matters:** it uses explicit account/provider/transport binding, fail-closed drift, evidence/receipts, and confirmation for consequential actions.
- **Where it fits:** beneath Hermes/Claude/Codex/MCP—not as a replacement for the agent framework, browser E2E tool, or provider SDK.
- **Caveat:** capability coverage is only what `wrench capabilities` has actually installed and observed. It does not bypass login, paywalls, DRM, or access control.

## 5. Writing and local conventions

### `AGENTS.md`, `WRITING.md`, `STYLE.md`
- **What they are:** repository-local instruction/prose contracts, not external products.
- **Role:** `AGENTS.md` contains mandatory behavioral/verification rules; the author uses `WRITING.md` for internal prose and `STYLE.md` for outward-facing copy.
- **Transferable lesson:** instructions should be short, scoped, current, and testable. Keep durable rationale/plans outside mandatory instruction files to avoid prompt bloat and rule conflict.

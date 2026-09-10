<!-- doc-head: Archived August 2026 software-factory research, not runtime authority -->
Dated sources, interpretations and project comparisons preserved during September consolidation.
Read for historical design context; verify current code and decisions before adopting recommendations.
<!-- /doc-head -->

# 03 — Stack, personal agents, and projects

## A. The declared application stack

The post calls this an intentionally uncomplicated stack. These are **components**, not one framework:

| Layer | Mentioned resource | Function in factory | Notes |
|---|---|---|---|
| Language/runtime | [TypeScript](https://www.typescriptlang.org/), [Bun](https://bun.sh/) | typed application code, tooling/runtime | Choice favors one JS/TS operating environment. |
| Web UI | [Next.js](https://nextjs.org/), [shadcn/ui](https://ui.shadcn.com/), [React Aria](https://react-spectrum.adobe.com/react-aria/) | application framework, composable UI, accessibility primitives | Product UI stack, not agent orchestration. |
| Hosting | [Vercel](https://vercel.com/) | deployments, domains, Blob | External hosting/control plane. |
| Application data/auth | [Convex](https://www.convex.dev/) with Auth; [Turso](https://turso.tech/) | reactive app backend and SQLite-compatible database | The post does not explain data ownership/consistency between both. |
| Model access | [Vercel AI Gateway](https://vercel.com/ai-gateway), [AI SDK](https://ai-sdk.dev/) | model-provider gateway and application AI integration | Separate from account/subscription orchestration. |
| Retrieval | [Exa](https://exa.ai/), [Voyage AI](https://www.voyageai.com/) | external web retrieval and embeddings/reranking family | Contrasts with Step 2's local QMD/EmbeddingGemma option. |
| Product services | [Resend](https://resend.com/), [PostHog](https://posthog.com/), [Stripe](https://stripe.com/) | email, analytics/experimentation, payments | All require their own operational/security boundaries. |

### How this stack fits the thesis

It gives agents predictable product seams: TypeScript contracts, a limited number of hosted services, and known testing targets. It does **not** itself prove autonomous safety. Direct/Wrench/KB/HRA are the operational layers built around it.

## B. Hraness's public project surfaces

### [hraness.com](https://hraness.com/) — author hub
The public hub identifies Ben Guo as a former Substrate/Zo Computer cofounder and former Stripe engineer. It links the projects below and is the best primary source for mapping the post's private factory vocabulary to public pages.

### [Zo Computer](https://zo.computer/) / Substrate — background, not a factory component
The author states he cofounded Substrate and later pivoted it to Zo Computer, a consumer agent/cloud-computer product. This explains his interest in personal agents and persistent computer use. It is not presented as the dependency that runs the described factory.

### [rough.day](https://rough.day/) — news aggregation surface
- **Claimed bot:** News Bot sends a daily summary.
- **Live site evidence:** a curated, categorized news page with article/source/discussion links and a stated "Why it ranked" rationale.
- **Factory role:** retrieval → ranking → brief generation → delivery. This is a good example of a read-only, low-risk autonomous loop.

### [stripehistory.com](https://stripehistory.com/) — sourced Stripe-history database
- **Claimed bot:** Stripe Bot alerts when something newsworthy happens.
- **Live site evidence:** a chronological, source-linked Stripe event catalog; entries distinguish report, proposal, completion and other statuses.
- **Factory role:** source ingestion + deduplication + editorial/status taxonomy + notification. Its status discipline is more valuable than its Stripe-specific topic.

### [act60.me](https://act60.me/) — Puerto Rico Act 60 guide
- **Claimed bot:** Act60 Bot manages administrivia around a generated CLI.
- **Live site evidence:** investor/business guidance and an operational checklist for applications, registration, payroll, books and annual filings.
- **Factory role:** structured domain checklist plus document/task collection.
- **Safety boundary:** legal/tax facts, applications and deadlines need expert review and explicit human approval. A guide or CLI is not legal/tax advice.

### [Atet](https://atet.sh/) — agentic media production toolkit
- **Claimed bot:** Atet Bot turns assets/ideas into images, diagrams and videos.
- **Live site evidence:** a Bun-based local CLI/skill for media generation, screen/video editing, captions, motion and multi-format export; project state and outputs stay local; model calls use caller-owned Vercel AI Gateway access.
- **Factory role:** an asset production pipeline with preview-before-final-output semantics.
- **Boundary:** media generation/editing is not autonomous publishing. Review/approval remains a distinct step.

### [Wrench](https://wrench.rip/) — see [02](02-factory-primitives.md)
- **Claimed bot:** Wrench Bot reads/summarizes/posts through connected social services.
- **Actual role:** a guarded capability layer. Social posting remains a consequential operation requiring an explicit reviewed capability and confirmation.

### PeopleBlade — agentic rolodex
- **Post claim:** the author ingested contact/activity metadata from iMessage, Apple Contacts, Gmail, LinkedIn, Telegram, WhatsApp, Instagram and Facebook, then enriches thousands of contacts.
- **Public target:** the author site names [peopleblade.com](https://peopleblade.com/), but independent product mechanics/privacy terms were not recovered in this pass.
- **Factory role:** identity resolution, contact graph, enrichment, and relationship context.
- **Risk:** highest-privacy category in the post. Cross-platform contact aggregation requires consent, source boundary controls, retention/deletion policy, and strict separation from outbound messaging.

### `Invest Bot` / [Public](https://public.com/)
- **Post claim:** connected a Public account, stored a portfolio strategy in the KB, then wakes up three times daily to iterate/execute.
- **Factory role:** strategy → scheduled evaluation → brokerage action.
- **Risk:** high-consequence financial activity. This is not transferable as unattended behavior without legal/compliance review, trading controls, position/risk limits, independent reconciliation and explicit approval gates.

### SEO Bot + [PostHog](https://posthog.com/)
- **Post claim:** iteratively improves SEO across web properties.
- **Factory role:** analytics → hypothesis → site change → measurement.
- **Caveat:** analytics can tell you outcomes, not validate publication safety, brand intent, or search-engine compliance. Changes need rollout/rollback and real ranking/conversion evidence.

### Read Bot / personal reading list
- **Post claim:** captures full contents of articles/videos/PDFs to the KB, summarizes them, and syncs useful results to the author's site.
- **Factory role:** ingest → durable source archive → retrieval/summarization → optional publication.
- **Caveat:** copyright/access terms, extraction quality, provenance and publication rights are all separate constraints.

### Additional engineering references surfaced from the post

- [fast-check](https://github.com/dubzzz/fast-check) is the JavaScript/TypeScript property-based testing library behind the post's named testing convention. Its role is systematic generation of cases/invariants; it does not replace scenario/E2E proof.
- [personal-monorepo-template](https://github.com/hraness/personal-monorepo-template) is the author's published personal-factory template. It combines a Next.js site, KB, Direct, skills, and optional PostHog, and is the public source for the `WRITING.md`/`STYLE.md` convention.
- `Bot` (`@bot`) is named as the agent host/UI, but no trustworthy official product destination was recovered. Do not infer that `bot.com` is the referenced service.

### Other public names from the author hub

| Name | Recovered URL/status | Apparent role |
|---|---|---|
| `aicharts.io` | [site](https://aicharts.io/) | model/agent comparison charts |
| `sleepy.land` | named on author hub; not investigated beyond index | calming-sound project, unrelated to factory core |
| `sound.fish` | named on author hub; not investigated beyond index | content-addressable music project |
| `rgnrte.com` | named on author hub; not investigated beyond index | calming/noise project |
| personal-monorepo-template | named on author hub; no target recovered here | author setup/template |
| `transmute` | named on author hub; public page not recovered in this pass | prior/adjacent media tooling name |
| `opRte` | named on author hub; public page not recovered in this pass | long-running parallel Codex interface; HRA appears to be the current public metaharness |
| `spongeresearch.com` | named by author site search; not in the X post body | knowledge/research project; outside primary scope |

### [Tokscale](https://tokscale.ai/leaderboard) — public token-use leaderboard
- **Post claim:** author is #60 globally.
- **Live site evidence:** public ranking of submitted usage with tokens/cost estimates; its current rank changes over time.
- **Factory role:** telemetry/visibility, not a quality or business metric.
- **Caveat:** token consumption is not useful output; public telemetry has privacy and cost-accounting caveats.

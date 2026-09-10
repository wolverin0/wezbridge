<!-- doc-head: Archived August 2026 software-factory research, not runtime authority -->
Dated sources, interpretations and project comparisons preserved during September consolidation.
Read for historical design context; verify current code and decisions before adopting recommendations.
<!-- /doc-head -->

# 08 — Synthesis: what this research says about OUR orchestration hardening
> The ultrathink deliverable. Maps every source (hraness pack 01-05, new sources 06) onto the
> 5-frentes hardening objective (claim mm-7bb0~6) and the operator's brainstorm: "Claude as
> orchestrator, bots provide curated info, crons drive, Claude delegates." Verdict: the
> brainstorm IS the industry-convergent architecture — with three corrections. Includes
> adopt/adapt/reject additions and a concrete first-implementation list.

## 1. The convergence (why this direction is right)

Five independent authors, same week, same shape. Strip the branding and every source describes
one architecture:

| Layer | hraness | dzhng | Hermes Bot Mode | ctrlnode | Our name |
|---|---|---|---|---|---|
| Durable knowledge | KB (md+git+sqlite) | living artifacts | per-bot memory | file/memory mgmt | MemoryMaster + _intel/ |
| Specialist workers | personal bots | implementer subagents | bots = profiles | agent nodes | panes + Hermes bots |
| Deterministic control | Direct states | seams + sensors | crons + inbox | task/control nodes + kanban | crons + graph.json + clawtrol |
| Evidence, not vibes | receipts/custody (Wrench) | decision ledger + traces | attributed inbox msgs | activity log | criteria: blocks + actions.jsonl |
| One human surface | operator reads receipts | "review the ledger, not the diff" | morning previews | one dashboard | Meta 02:00 rollup |

The consensus is loud on one inversion: **the human (and the orchestrator) reviews decisions
and receipts, never raw output streams.** dzhng: a 2-day run = tens of thousands of lines,
~30 decisions that matter; read the 30. That is exactly our diagnosis of pane-0 drowning in
monitor scrollback.

## 2. The operator's brainstorm, engineered

> "make you the orchestrator and the bots provide the curated info you need, and you delegate"

Validated, with this precise division of labor:

```
                 [ Hermes bots + crons  =  SENSORY LAYER ]
  cron (no_agent / wakeAgent gates) → runs checks at $0
  bot (researcher/meta/jarvis)      → curates raw signal into a BRIEF (file, not chat)
  briefs land in                    → _intel/briefs/ + one line in a queue file
                                          │
                 [ Claude pane-0     =  DECISION LAYER ]
  reads queue + briefs (never raw noise) → decides → dispatches via a2a queue-file
  logs every dispatch in actions.jsonl   → never does bookkeeping turns
                                          │
                 [ Panes/bots        =  EXECUTION LAYER ]
  bounded jobs, checkpointed, auto-close on result
  every result = derivation packet: criteria per-item pass|fail + evidence + files_changed
                                          │
                 [ Meta (02:00)      =  OPERATOR SURFACE ]
  daily rollup: decisions taken, evidence, exceptions, orchestrator self-eval
  operator reads ONE inbox; drives by exception
```

Three corrections to the brainstorm (the engineering part):

1. **Bots curate into FILES, not into your chat.** The A2A gotcha of 21-ago (envelopes lost in
   transit to busy panes) and the Bot Mode "Agent Inbox" pattern agree: the unit of exchange is
   a durable, attributed queue entry the consumer reads at the start of its run — not a message
   that must land while someone is listening. We already wrote this rule (briefs in
   `_intel/briefs/` + short pointer); the research upgrades it from workaround to architecture.
2. **The orchestrator must also be interruptible.** The "Learned How to Stop" piece is about us
   too: a waker/queue design needs cancelled-stays-cancelled semantics (no zombie results
   re-entering after the operator redirected) and steer/queue/stop as distinct verbs. Our
   autopilot re-enable checklist should include: stop parks the queue; stale activations can't
   steal focus (Hermes profile-switch race rule).
3. **Delegation needs a decision ledger, not just an action log.** actions.jsonl records WHAT
   happened (spawn/kill/turn). dzhng's ledger records the decisions made where the spec was
   silent, ranked least-confident first, auditable by a separate non-blocking pass. That is the
   missing attribution layer for judgment, and it is cheap: a template block in each
   `type=result` + orchestrator-turn.

## 3. Mapping to the 5 frentes (evidence per frente)

| Frente (mm-7bb0~6) | Research support | Upgrade it suggests |
|---|---|---|
| 1. Ruteo A2A por PROYECTO + cola-archivo + auto-ack (0 misroutes) | Agent Inbox (attributed, persistent, consumed at run start); ctrlnode kanban BACKLOG→INBOX→ACTIVE→DONE | Queue file keyed by project/bot NAME (pane-ids renumber — same reason "a Bot is a Profile", not a window). Auto-ack = inbox protocol clause in every pane's contract. |
| 2. Waker clasificador (<20% turnos sin acción) | Hermes cron **pre-run gates**: script emits `{"wakeAgent": false}` → $0 skip; `no_agent=True` watchdogs; per-job model pins | Our waker becomes: deterministic script classifies event → only results-directed/stall/exception wakes the LLM. This is F1's design, confirmed by a shipping product. |
| 3. Lifecycle enforcement (tope 5, afinidad, auto-close) | Bot HR (spec → team composition → model-per-role, explained); "bots temporary, skills permanent"; profile rule: create one only when the separation should persist | Affinity table = Bot-HR-style model-per-role, written down and enforced in spawn path. Auto-close post-result = "bots are temporary per project". |
| 4. Atribución total | dzhng decision ledger + auditor rules (separate context, never blocks, can't edit); zoetrope (transcript = ground truth, replayable) | Extend actions.jsonl with per-run `decisions:` blocks; adopt zoetrope for visual replay of any pane's JSONL when auditing an incident. |
| 5. Una bandeja (Meta 02:00) | "Review the ledger, not the diff"; morning-ops workflow (operator reads previews, drives by exception); hraness receipts | Meta's rollup = ledger digest: decisions (least-confident first), exceptions, receipts. Operator pushback loop = dzhng's "I push back on four". |
| Transversal: bookkeeping ≠ orchestrator turns | wakeAgent gates; no_agent crons; deterministic transforms in code (our own rule) | Every auto-ack/heartbeat is a script, never a M-token turn. |

## 4. Adopt / adapt / reject — additions to pack 04

| Idea | Decision | Why |
|---|---|---|
| **Decision-ledger skill** (dzhng audit-choices) | **ADOPT now** | Cheapest highest-leverage: template in `type=result` + a non-blocking audit pass. Solves the "self-reported success" hole F0 anti-slop found. |
| **Cron pre-run gates / no_agent** | **ADOPT now** (F1 already designed it) | Independent confirmation of F1's zero-token watchdog + waker-classifier design. Proceed with confidence when F1 unpauses. |
| **zoetrope** | **ADOPT as tool, this week-level effort** | Reads `~/.claude/projects/*.jsonl` — OUR transcripts, zero integration. Live flow graph + replay of fleet sessions; zero-network. Install via cargo/binary; also browser WASM. Perfect for the orchestrator-evaluation loop and incident replay. |
| **Bot HR pattern** | **ADAPT** | We hand-roll team composition per project today. A "bot-hr" SOUL/skill that reads a spec and proposes team+models+SOULs (operator approves) matches lifecycle frente. Don't let it spawn unaided — gate stays. |
| **Fog-of-war scouting before slicing** | **ADOPT as method** | Our big-task failures are unknown-shape failures. Scout → decision table → slice → re-slice. Fits /goal discipline (verifiable exits per slice). |
| **Group-chat shared context** (all bots read the same room) | **DEFER** | Attractive vs our lost-envelope pain, but our transport is panes, not one room. Revisit if Hermes fleet becomes primary execution layer. |
| **ctrlnode** | **REJECT as product, MINE as design** | Cloud app + ELv2 + own runtime = overlap with wezbridge/clawtrol. Its kanban lifecycle + outbound-only bridge + "control nodes as first-class" validate clawtrol-as-graph-executor. |
| **ECC** | **REJECT install; cherry-pick** | 68 agents/286 skills/94 commands is the bloat our <200-line rule exists to prevent. Worth stealing: instinct extraction (Stop-hook mining transcripts into confidence-scored heuristics ≈ our MM dreams), hook profiles via env var, AgentShield idea (hook/MCP security scanning). |
| **"Continual learning is solved"** | **REJECT** (unchanged from 04) | Still an opinion; our layered-memory harness doc already handles it. |
| **Token-burn leaderboards / 15-subscription scale** | **REJECT** (unchanged) | Measure verified completed work. |

## 5. Concrete first implementations (when hardening unpauses — NOT started, per gate)

1. **criteria: block v2 → derivation packet**: add `decisions:` (spec-silent choices, confidence,
   would-have-asked) and `evidence:` fields to the A2A result parser. One parser change + one
   protocol doc edit.
2. **Waker classifier as pre-run gate script** (frente 2): deterministic classification before
   any orchestrator turn; log skipped wakes to actions.jsonl at $0.
3. **Install zoetrope** and point it at the fleet's project dirs; use it in the daily Meta
   self-eval and any incident postmortem.
4. **bot-hr skill draft** for team composition proposals (operator-gated).
5. **Steer/queue/stop verbs** in the autopilot re-enable checklist, with cancelled-stays-cancelled.

## 6. What we already have that the sources don't (keep it)
- **Operator-gate discipline** (graph.json kinds, peer-relay-never-lifts-gate): stronger than
  anything in these sources; dzhng's "audit never blocks" complements, doesn't replace it.
- **MemoryMaster governed claims** vs everyone's plain-markdown KBs: our conflict handling,
  scopes, and steward promotion are ahead. Their lesson is only: keep repo-local evidence
  inspectable too (we do: _intel/, artifacts/, monitoring.md).
- **Verified-submission transport** (a2a_send submitted field) — none of the sources verify
  message delivery at all; Bot Mode assumes its own inbox works.

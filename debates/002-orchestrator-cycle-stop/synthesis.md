# Debate Synthesis: Stop the omni-orchestrator iteration cycle?

**Date:** 2026-04-30
**Style:** thorough · authoritative moderation · 1 round
**Question:** Refuse to build iteration 4 of an autonomous multi-pane orchestrator and ship 5 narrow human-in-the-loop phases instead?

## Advisor Summary

| Advisor | Position | Confidence | Key Assumption |
|---------|----------|------------|----------------|
| **Codex** (gpt-5.5) | Agree with stop-the-cycle, conditional on a 2-day falsification spike | 82% | Goose subagents truly didn't call the LLM; failure is at coordination layer not single-agent layer |
| **Claude** (opus-4-7) | Agree, but reorder P3 (tests) before P1 (recipe) | 78% | The summon hang is real upstream, the manual pattern's success at 1-2 concurrent waves generalizes to 5+ |
| **Gemini** | DROPPED (rate-limited 1h26m) | — | — |

## Consensus (both responding advisors agree)

- All three prior iterations failed at the **coordination layer**, not the single-agent layer. Goose, omniclaude, and theorchestra each work fine when running a single agent; multi-agent fan-out is what consistently breaks.
- The manual human-in-the-loop pattern is **proven**: 19 fembeing waves in 17 hours is real output, not a kludge.
- **P5 (refusing to build the autonomous version)** is the load-bearing commitment of the plan. Without it, in 6 weeks we will rationalize iteration 4 the same way we rationalized 1→2 and 2→3.
- The 1000+ hour sunk cost is a **red flag, not a justification** to continue.
- Integration tests (P3) are what would have caught the W5 hang on day 1 — both advisors flag this.

## Disputed Issues

- **Phase ordering**: Claude argues P3 (tests) must precede P1 (peer-pane recipe), or we ship "iteration 4 disguised as a recipe" without the test discipline. Codex implicitly accepts the original P1→P3 ordering. **Resolution:** adopt Claude's reorder — write the "spawn 2 panes, both produce a commit, no cross-bleed" test FIRST, then build the recipe to make it pass.
- **Adapter vs architecture**: Claude's spike candidate = run the same fembeing 2-sub-agent review under goose with the **OpenAI provider** instead of claude-acp. If it works, the bug is adapter-specific and W5 is rescuable cheaply. Codex's spike candidate = bypass goose entirely and build a **durable external queue** (SQLite/Postgres job table, worker processes, heartbeat). These are different spikes targeting different hypotheses.

## Risks & Failure Modes

| Risk | Raised by | Severity |
|------|-----------|----------|
| Manual pattern hits a ceiling at 5-10 concurrent projects (operator-attention bound) | Codex | High |
| P5 calcifies around today's broken adapters; locks us out when LLM platforms ship native multi-agent primitives | Claude | High |
| P1 peer-pane recipe fails at 5+ panes the same way summon did, discovered in production | Claude | Medium |
| Refusing iteration 4 leaves real leverage unexplored | Codex | Medium |
| The "manual" pattern's 17-hour result was a single-operator burst, not a sustained baseline | (implicit) | Medium |

## Recommendations

| Priority | Action | Source |
|----------|--------|--------|
| 1 | Run a **2-day falsification spike** BEFORE committing to P5. Pick ONE of the two spike paths: (a) swap goose adapter from claude-acp to OpenAI and re-run the fembeing 2-sub-agent review, OR (b) build Codex's queue+worker+heartbeat MVP and run 3 independent repo reviews. If either succeeds in <10min, P5 is premature. If both fail, P5 stands. | Both |
| 2 | Reorder phases: **P0 → P3 → P1 → P2 → P4 → P5**. Write the "spawn 2 panes, both commit, no cross-bleed" integration test FIRST. Make it the gate the recipe must pass. | Claude |
| 3 | Soften P5's wording from "never build autonomous" to "**not building OUR own autonomous orchestrator on top of generic LLM CLIs**." Leave room for adopting a vendor-shipped primitive (e.g., if Anthropic ships subagent_v2 with proper task isolation). | Claude |
| 4 | Add an explicit **scale-watch metric** to the manual pattern: track concurrent-waves-per-operator-hour. If this number cracks at 4+, revisit P5. | Codex (extrapolation) |
| 5 | Tag orchestra-goose at current state, mark Wave 5 BLOCKED in the roadmap, archive theorchestra v3 dashboard regardless of spike outcome (P0 holds). | Both |

## Conclusion

**Both advisors converge on YES with caveats.** The core thesis — stop iterating, ship the human-in-the-loop pattern, refuse iteration 4 — is correct. But neither advisor is comfortable making P5 a dogmatic "never again" without first running a cheap spike that falsifies the core failure mode.

**Recommended decision:**

1. **Today**: do P0 (tag, mark blocked, archive). It's reversible and removes ambient pressure.
2. **This week (2 days max)**: run the dual spike — Claude's adapter-swap (1 day) + Codex's queue+worker MVP (1 day). Both failing → P5 is real. Either succeeding → revise the plan.
3. **If P5 stands after the spike**: execute P3 → P1 → P2 → P4 in that order. Reword P5 to scope it to "our own autonomous orchestrator on top of generic CLIs" — leave the door open for vendor-native primitives.
4. **Add scale-watch**: track concurrent-waves-per-operator-hour. If it cracks at 4+, the plan needs revisiting regardless of P5.

The unique value of this debate is the **2-day spike requirement**. Without it, "stop the cycle" is indistinguishable from giving up on a fixable problem. With it, "stop the cycle" becomes a falsifiable architectural claim — the same discipline (P3 integration tests) that we're trying to install everywhere else.

## Metadata

- Rounds completed: 1 / 1
- Early stop: no
- Advisors responding: 2 of 3 (Gemini dropped — rate limit)
- Models: Codex (gpt-5.5), Claude (opus-4-7)
- Both responding advisors: confidence ≥78%, agree on stop-the-cycle, agree on running a falsification spike before P5

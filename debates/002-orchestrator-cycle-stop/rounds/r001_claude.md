**Position:** AGREE with stop-the-cycle, but with one concrete amendment: P3 (integration tests) must come BEFORE P1 (peer-pane recipe), not after — otherwise we ship iteration 4 disguised as a "recipe" without the test discipline that would catch its failure mode on day 1.

**Key Arguments:**
- The pattern across all 3 failures is identical: we built the *mechanical* infrastructure (PTY scrape, JSON contract, MCP fan-out) but never wrote the integration test that says "spawn 2 panes, both produce a commit, no cross-bleed." Iteration 4 will fail the same way unless P3 leads.
- The "manual" pattern shipping 19 waves in 17 hours is not a kludge — it's the actual design. Claude-as-orchestrator is the planning layer; goose-pane-as-worker is the execution layer; the wave-kickoff template is the contract. That IS the orchestrator. The "autonomous" version is a refusal to admit this.
- P5 (refusing to build the autonomous version) is the unique commitment. Without it, in 6 weeks we will rationalize iteration 4 the same way we rationalized 1→2 and 2→3. "But this time the framework is different" is the failure mode.
- The 1000+ hour sunk cost is a red flag, not a reason to continue. Every iteration started with "this time the substrate handles it natively." The substrate didn't matter; the test discipline did.

**Assumptions:**
- The summon Task tool hang is a real upstream bug, not a config issue I missed (W5 acceptance test would confirm or refute in 1 day).
- The wezterm cli spawn + send-text path actually works at 5+ panes (proven at 2 panes via wezbridge-compat shim; not yet at 5).
- The user's tolerance for "human stays in the loop" is durable. If they later say "I want to walk away for 8 hours," P5 needs revisiting.

**Risks / Failure Modes:**
- BIGGEST RISK of stop-the-cycle: declaring "never again" lockss us out of legitimate future progress when LLM platforms ship native multi-agent primitives (e.g., if Anthropic ships a real subagent_v2 with proper task isolation, refusing to use it is dogma). Mitigation: P5 should be "not building OUR own autonomous orchestrator on top of generic LLM CLIs" — leave room for adopting a vendor-shipped primitive.
- P1 peer-pane via wezterm cli could itself fail at 5+ panes the same way summon did, and we'd discover it in production. P3-first prevents this.

**What Would Change My Mind:**
- A 2-day spike that demonstrates summon Task tool works under a *different* adapter (not claude-acp). If the bug is adapter-specific not summon-architectural, iteration 4 is cheap: switch adapter. Concrete spike: run the same fembeing 2-sub-agent review under goose with the OpenAI provider instead of claude-acp. If it works in <10 min, the W5 hang is adapter-side and P5 is premature.
- Evidence that the manual pattern degrades at 4+ concurrent waves. So far it's been validated at 1-2 concurrent. If it cracks at scale, we may need *something* more autonomous, even if not "iteration 4."

**Confidence:** 78%

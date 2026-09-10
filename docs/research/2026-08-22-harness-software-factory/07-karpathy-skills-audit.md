<!-- doc-head: Archived August 2026 software-factory research, not runtime authority -->
Dated sources, interpretations and project comparisons preserved during September consolidation.
Read for historical design context; verify current code and decisions before adopting recommendations.
<!-- /doc-head -->

# 07 — Audit: is multica-ai/andrej-karpathy-skills still applied in our workflows?
> Operator asked (22 ago): "see if we still have this applied throughout all our workflows
> and files — we had done it once, maybe superseded by things we did after or outdated."
> VERDICT: **not installed anymore; SUPERSEDED — every one of its 4 principles survives in a
> stronger, currently-loaded layer.** No action needed except awareness. Evidence below.

## What the repo is
`multica-ai/andrej-karpathy-skills` (mirror of forrestchang's): ONE skill, "Karpathy Guidelines",
four principles distilled from Karpathy's observations about LLM coding failure modes:

1. **Think Before Coding** — no silent assumptions; surface interpretations and confusion first.
2. **Simplicity First** — no speculative features/abstractions; fight overengineering.
3. **Surgical Changes** — touch only what the task requires; no drive-by refactors.
4. **Goal-Driven Execution** — turn imperative tasks into verifiable success criteria and loop.

Install paths it uses: Claude Code plugin (`andrej-karpathy-skills@karpathy-skills`) or appending
its CLAUDE.md to a project.

## Evidence gathered (2026-08-22)

| Check | Result |
|---|---|
| `~/.claude/plugins/installed_plugins.json` | **No karpathy plugin.** Installed relevant set: `agent-skills@addy-agent-skills`, `superpowers@claude-plugins-official` + `@superpowers-marketplace`, `compound-engineering@compound-engineering-plugin`. |
| `~/.claude/plugins/marketplaces/` | No karpathy marketplace among the 10 present. |
| `known_marketplaces.json` | No karpathy/multica entry. |
| Current `~/.claude.json` | Single "karpathy" hit = the `karpathy/autoresearch` repo clone at `C:\Users\pauol\autoresearch` (different lineage — it became our `autoresearch` skill). |
| Grep `Think Before Coding|Surgical Changes|Simplicity First|Goal-Driven Execution` across all `AGENTS.md`/`CLAUDE.md`/`GEMINI.md` under Py Apps | Only one unrelated third-party clone (`repos/opencode-plugin-analysis/clones/DVNghiem--FlowDeck`). None of OUR files carry the literal skill text. |
| `~/.claude/skills/` | No karpathy skill dir. `autoresearch/references/core-principles.md` cites Karpathy (autoresearch principles, separate thing, still active). |

## Where each principle lives TODAY (the superseding layers)

| Karpathy principle | Current enforcement layer (loaded automatically) |
|---|---|
| Think Before Coding | `agent-skills@addy` SessionStart hook: "Surface Assumptions" + "Manage Confusion Actively" (STOP, name the confusion, wait). Also `superpowers:brainstorming` gate before creative work. |
| Simplicity First | `agent-skills@addy`: "Enforce Simplicity" ("if you build 1000 lines and 100 would suffice, you have failed"). |
| Surgical Changes | `agent-skills@addy`: "Maintain Scope Discipline" + global CLAUDE.md **STOP rules 1 & 3** ("Do what I ask — nothing more"; "Never rewrite components from scratch; minimal diffs"). |
| Goal-Driven Execution | Global CLAUDE.md **"/goal discipline"** section (verifiable exit criteria, done-test re-evaluated each turn) + `autoresearch` skill (modify→verify→keep/discard loop) + STOP rule 2 ("never report success without running the code"). |

Plus layers the karpathy skill never had: `superpowers:verification-before-completion`,
`superpowers:systematic-debugging`, the F0 anti-slop rule (run the signal source before
asserting), and the Knowledge Compiler rule (corrections → enforcement artifacts).

## Verdict
- **Applied?** Not as an artifact. It was present historically (the operator remembers doing it;
  today only the separate `karpathy/autoresearch` clone remains in config).
- **Superseded?** Yes, and strictly upgraded: the four ideas are now (a) auto-loaded every
  session via the addy agent-skills SessionStart hook, (b) hard-gated by operator STOP rules,
  (c) extended by superpowers + /goal discipline. Re-installing the karpathy plugin would add a
  THIRD copy of the same prose — pure context bloat, against the <200-line instruction rule.
- **Residual gap:** none found. The only Karpathy lineage worth keeping current is
  `autoresearch` (different repo, still installed as a skill).

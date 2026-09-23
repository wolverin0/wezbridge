# RETIRED 2026-09-23 (T-0547): this hook parsed a toolCall/workspacePaths payload that neither Claude Code nor Codex sends, so it never fired.
# Replacement: ~/.claude/hooks/lane-guard.cjs (PreToolUse; active when env WEZ_LANE is set and the call has no agent_id).
# Companions: lane-routing-context.cjs (UserPromptSubmit) and lane-route-audit.cjs (Stop) -> Py Apps/_intel/route-audit.jsonl.
# Tests: wezbridge/test/lane-hooks.test.cjs. Design: _intel/briefs/2026-09-23-delegation-enforcement-MEMO.md option A.
# Intentionally a no-op; do not re-wire it.

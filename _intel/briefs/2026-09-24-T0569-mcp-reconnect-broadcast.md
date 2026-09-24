<!-- doc-head: T-0569 brief — broadcast /mcp reconnect <server> to idle Claude panes only -->
Covers: scripts/mcp-reconnect-broadcast.cjs (CLI + module), its test suite, docs/operations.md
"MCP desconectado" section. Key terms: skip:self-busy, ORCA_TERMINAL_HANDLE, idle+empty-composer
gate, provider=claude filter, --dry-run, --include-busy-self.
Read when: extending the broadcast to another MCP server, or debugging why a pane was/was not
targeted.
<!-- /doc-head -->

# T-0569 — MCP reconnect broadcast (T3)

task_id=T-0569 tier=T3. Repo wezbridge.

Operator request (23/09, card T-0569): all MemoryMaster MCP connections in all panes can be
reconnected by auto-sending `/mcp reconnect memorymaster`; done by hand from PowerShell it
works ("Successfully reconnected"). Card notes: send from PowerShell or node (Git Bash converts
`/mcp` into a path — if you shell out through Git Bash use MSYS_NO_PATHCONV=1 or spawn directly
from node without a shell); include the caller's own pane (see safety rule below).

Build `scripts/mcp-reconnect-broadcast.cjs <server> [--dry-run] [--include-busy-self]`:
- Enumerate terminals from the Orca census (src/orca-census.cjs — reuse its runOrca / snapshot
  reading, injectable for tests); keep only provider=claude panes.
- SAFETY: send only to panes that are IDLE with an EMPTY composer (reuse
  scripts/composer-state.cjs / pane-discovery status detection). Working / awaiting-permission /
  composer-has-text panes are SKIPPED and reported as skip:<reason> — never typed into. Never
  codex/shell panes. The caller's own pane is usually busy (it's running the script): report it
  as skip:self-busy and print the exact manual command for the operator; do not type into a busy
  pane.
- `--dry-run` lists targets + skips, sends nothing.
- Send `/mcp reconnect <server>` + Enter via the fleet's verified-send path (orca terminal send
  or src/verified-send.cjs), poll the screen ≤10 s, classify ok ("Successfully reconnected") |
  fail (error text) | unknown (timeout); print table handle | project | result | excerpt. Exit 0
  if all targeted ok, else 1.

Acceptance:
1. test/mcp-reconnect-broadcast.test.cjs with orca/composer doubles: 3 panes (2 claude idle, 1
   codex) → only the 2 claude get the command; a working claude pane → skipped, nothing sent; a
   claude pane with composer text → skipped. Mutation: remove provider filter → test fails;
   remove idle gate → test fails.
2. REAL run: `node scripts/mcp-reconnect-broadcast.cjs memorymaster --dry-run` (paste), then real
   `node scripts/mcp-reconnect-broadcast.cjs memorymaster` (paste table). Only idle Claude panes
   receive it.
3. docs/operations.md: section "MCP desconectado" → script usage + safety rule.
4. `node --require ./test/setup.cjs --test test/mcp-reconnect-broadcast.test.cjs` pass; `npm
   test` counts (known flakes only).
5. Conventional commits ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`;
   `git push -u origin feat/t0569-mcp-reconnect-broadcast`; `gh pr create --base main` (body incl.
   the real-run table) ending `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
   Do NOT merge.

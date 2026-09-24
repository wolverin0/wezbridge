# T-0568 — catastrophic-command kill guard (brief)

Covers: wezbridge `src/catastrophic-commands.cjs` classifier + tests, a patch file for the
operator-owned `~/.claude/hooks/lane-guard.cjs`, and a one-line addition to the pedrito
orchestrator brief. Root cause: a pedrito worker ran `taskkill /F /IM python.exe /T` and killed
every Python process on the host (MemoryMaster MCP + other operator services) because
lane-guard only filters the orchestrator pane (no agent_id); subagents pass through untouched.
Read this before touching the guard/classifier files listed below.

## Problem
A pedrito-lane worker ran `taskkill /F /IM python.exe /T` to stop its preview server and killed
every Python process on the PC (MemoryMaster MCP and other operator services). lane-guard today
only filters the orchestrator; subagents (payload with agent_id) pass through.

## Design (orchestrator decision)
Put the rule set in the wezbridge repo so it's versioned and tested, and make the hook a thin
caller:

1. New module `src/catastrophic-commands.cjs` exporting
   `classifyCatastrophic(command: string) -> {deny: boolean, rule: string|null, reason: string}`
   — pure, no I/O. Deny (fail-closed for this group, for EVERYONE, with or without agent_id):
   `taskkill` with `/IM` (any image, any flag order/case, incl. `taskkill.exe`, `/im`, `-im`);
   `Stop-Process -Name` (and `spps -Name`, `kill -Name` alias in PowerShell,
   `Get-Process <name> | Stop-Process`); `pkill`/`killall` by name incl. `pkill -f`;
   `kill -9 -1` / `kill -KILL -1` / `kill -1`-style mass kill; `shutdown`, `Restart-Computer`,
   `Stop-Computer`, `reboot`, `poweroff`; `wmic process ... delete`/`call terminate` by name;
   `docker stop|kill|rm` with `$(docker ps -q)`/`-a -q`/no explicit container name. ALLOW:
   `taskkill /PID <n>` (with /F, /T), `Stop-Process -Id <n>`, `kill <pid>`,
   `docker stop <explicit-name>`. Handle chained commands (`&&`, `;`, `|`, newlines,
   `cmd /c "..."`, `powershell -Command "..."`, `bash -c '...'`): deny if ANY segment is
   catastrophic. Deny reason text must tell the agent what to do instead (kill by PID you
   started / use the tool's own stop command).
2. Tests `test/catastrophic-commands.test.cjs`: the card's 4 cases verbatim plus the other
   rules, allow-cases, chained/wrapped variants, and false-positive guards (quoted literal text
   inside another command's own arguments, e.g. `git commit -m "taskkill /IM"`, is allowed;
   `grep taskkill file.txt` is allowed). Mutation: disable the /IM rule -> test fails.
3. Produce `_intel/briefs/2026-09-23-T0568-lane-guard.patch` (unified diff against the current
   `~/.claude/hooks/lane-guard.cjs`) that, BEFORE the orchestrator/agent_id early return,
   requires the wezbridge module by absolute path and denies when `classifyCatastrophic` says
   so; FAIL-CLOSED for Bash/PowerShell tool calls if the module can't be loaded. Verify the
   patch applies cleanly against a scratch copy and run `test/lane-hooks.test.cjs`-equivalent
   payloads against the patched copy. lane-guard.cjs itself stays untouched in this repo/PR —
   it is operator-owned under `~/.claude/hooks`.
4. Add one line to `_intel/briefs/2026-09-23-PEDRITO-ORCH-brief.md`: workers must never kill
   processes by name; stop only PIDs they started, or use the tool's own stop command.
5. `npm test` full run, report counts (pre-existing unrelated failures expected in a worktree).
6. Commits `test(guard): ...` then `feat(guard): catastrophic command classifier (T-0568)` +
   `docs: ...`; push branch `fix/t0568-catastrophic-kill-guard`; open a PR with the patch content
   inline and the operator apply-step spelled out. Do NOT merge.

# Destructive-Op Guard — Usage

The guard is an opt-in pre-execution block-layer for dangerous git/gh
commands. It closes the gap that `wezterm cli get-text` polling can only
DETECT post-hoc — by the time the Monitor sees `gh pr merge 170`, it's
already on GitHub. The guard intercepts BEFORE the binary runs.

See `docs/PLAN-managed-agents-backfill.md` Task #1 for the design.

## What gets blocked

| Command pattern | Why |
| --- | --- |
| `git push origin main` / `master` | protected default branch |
| `git push --force` / `-f` / `--force-with-lease` | rewrites remote history |
| `git reset --hard` | discards working changes |
| `git checkout .` | mass-discards local changes |
| `git clean -fd` / `-fdx` | deletes untracked files |
| `git branch -D <name>` | force-delete branch with unmerged work |
| `gh pr merge <n>` | auto-merge to base branch (usually main) |

Allowed (passthrough): `git status`, `git log`, `git push origin
<feature-branch>`, `git reset HEAD~1` (soft), `gh pr create`, `gh pr list`,
`gh pr view`, anything else.

## Two ways to activate

### Option A — opt-in for long-lived wezbridge processes

Run the dashboard or MCP server with the env flag:

```bash
WEZBRIDGE_GUARD_SHIMS=1 npm run dashboard
WEZBRIDGE_GUARD_SHIMS=1 npm run mcp
```

`src/guard-bootstrap.cjs` runs at module load, prepends `bin/guard-shims/`
to PATH. Every wezterm-spawned pane inherits the env, so calls like
`git push origin main` from inside spawned Claude/Codex panes are blocked.

### Option B — opt-in for your interactive shell

Add to your `.bashrc` / `.bash_profile` / `.zshrc`:

```bash
[[ -d "$HOME/path/to/wezbridge/bin/guard-shims" ]] && \
  export PATH="$HOME/path/to/wezbridge/bin/guard-shims:$PATH"
```

For PowerShell, in `$PROFILE`:

```powershell
$shim = "C:\path\to\wezbridge\bin\guard-shims"
if (Test-Path $shim) { $env:PATH = "$shim;$env:PATH" }
```

Now your own terminal calls hit the guard too.

## Bypassing the guard

When you genuinely intend to run a blocked command, prefix once:

```bash
WEZBRIDGE_GUARD_OVERRIDE=1 git push origin main
```

The override applies to that single call only — it's an env var, not a
config setting.

## Verifying it works

```bash
# Should block
bin/guard-shims/git.sh push origin main
# → command-guard: BLOCKED — git push to main/master — protected branch
# → exit 1

# Should pass through
bin/guard-shims/git.sh --version
# → git version 2.45.1.windows.1
# → exit 0
```

## How it's wired

```
your-shell  ──›  PATH=[bin/guard-shims, ..., real-git-dir]
                     │
                     ▼
             bin/guard-shims/git.sh    ← shim hit first
                     │
                     ▼
             scripts/command-guard.cjs   ← evaluator
                     │
            ┌────────┴────────┐
            ▼                 ▼
         allowed?          blocked?
            │                 │
            ▼                 ▼
        exec real git     exit 1 + stderr
```

Files:
- `scripts/command-guard.cjs` — pure-logic evaluator (library + CLI).
- `test/command-guard.test.cjs` — 29-case unit test.
- `bin/guard-shims/{git,gh}.{sh,cmd}` — shell entry points.
- `src/guard-bootstrap.cjs` — auto-prepends PATH for long-lived servers
  when `WEZBRIDGE_GUARD_SHIMS=1`.
- `test/guard-bootstrap.test.cjs` — 4-case bootstrap test.

## Customizing patterns

Add a new entry to `DESTRUCTIVE_PATTERNS` in `scripts/command-guard.cjs`:

```js
{
  name: 'rm_rf_anywhere',
  test: (argv) => argv[0] === 'rm' && argv.includes('-rf'),
  reason: 'rm -rf — deletes recursively',
},
```

Then add a corresponding test case in `test/command-guard.test.cjs` and a
shim at `bin/guard-shims/rm.{sh,cmd}` mirroring `git.sh`.

## Limitations

- **Ad-hoc shells without the shim PATH**: a user manually invoking
  `/c/Program\ Files/Git/cmd/git.exe push origin main` directly bypasses
  the guard. The guard is shell-PATH gated, not kernel-level.
- **In-process child_process.exec(`git ...`) calls** from Node code
  bypass the guard when the child inherits the parent's PATH but the
  parent didn't bootstrap. This is by design — `commit-guard.js` covers
  the Claude PreToolUse path for those.
- **Aliases that bypass PATH** (e.g., `alias git=/usr/bin/git`) bypass the
  guard. Don't write defeating aliases.

## Related

- `scripts/commit-guard.js` — sibling guard, fires at git pre-commit and
  Claude Code PreToolUse. Covers a different surface (commit-time vs
  pre-execution); patterns are partially overlapping but maintained
  separately by design.
- `docs/PLAN-managed-agents-backfill.md` — full 12-item plan; Task #2
  builds the same idea into wezbridge-native MCP/dashboard handlers
  (`send_prompt`, `kill_session`, etc.) which the PATH gate doesn't
  cover.

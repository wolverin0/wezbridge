# Routine: test-strength-audit

**Cadence:** weekly · **Mode:** findings-only, never modifies code · **Host:** fresh headless session

## Why this routine exists

On 2026-08-13 pane-0 wrote a guard plus seven tests, then disabled the guard entirely with `if (false)`.
**All seven tests still passed.** They matched source text, and the constant they searched for still appeared
inside the error message the disabled guard would have returned. A test suite that survives the removal of
the thing it tests is not a test suite.

That was found by hand, once, because someone happened to run a mutation. Nobody runs it every time.
This routine runs it every time.

## Where you are running

You are a scheduled routine in a fresh session with no conversation history, and you will exit when done.

**Your working directory is a disposable git worktree, detached at HEAD.** It is a real checkout that gets
deleted the moment you exit, whether you cleaned up or not. Mutate freely inside it — that is what it is for.

Two consequences to plan around:

- **The project's own `CLAUDE.md` / `AGENTS.md` are NOT loaded**, because you are not under the project path.
  Read them from `$ROUTINE_REPO_DIR` (the real repo) when you need the test command or project conventions.
  Read only — never write there. That directory is the operator's live tree.
- **Dependencies may be missing.** A fresh worktree has no `node_modules`, no `.venv`, no build output. If the
  test command cannot run for that reason, the verdict is **`void`** — say so in `void_reason`. It is not
  `clean`, and it is not a finding about the tests either.

## Your task

1. Pick **up to 8** test files, preferring ones changed in the last 14 days (`git log --since`).
2. For each, identify the specific behaviour under test — the function, branch or condition it claims to
   protect.
3. **Mutate the subject, not the test.** Disable the behaviour: invert a condition, return early, replace a
   guard with a constant, delete a branch.
4. Run only that file's tests.
5. **If the tests still pass, the mutation survived and the test is not testing what it claims.** Record it.
6. **Restore the mutation immediately.** Verify the tree is clean (`git status --porcelain` empty) before
   moving on. A routine that leaves a mutation behind is worse than no routine.

## Hard rules

- **Findings only.** Do not fix, delete or rewrite any test. Deleting a test is on the never-auto-merge list.
- **Restore after every mutation anyway**, even though the worktree is disposable. One mutation left standing
  while you test the next one silently invalidates that result, and you would not be able to tell.
- **Never write outside the worktree**, with exactly one exception: the output file at `$ROUTINE_OUT`.
- If a test file cannot be mutated meaningfully, say so. "Could not construct a mutation" is a real result
  and is not a pass.
- Do not touch anything on the never-auto-merge list: auth, payments, migrations, destructive data ops,
  secrets, deployment.

## Output

**Write exactly one file, at the absolute path in the `ROUTINE_OUT` environment variable.** Do not invent a
path. A relative path resolves inside the worktree and is deleted with it — you would produce nothing, and
the run would be recorded as having no output.

```json
{"routine":"test-strength-audit","repo":"<name>","date":"<iso>",
 "files_examined":<n>,"mutations_attempted":<n>,
 "survived":[{"test_file":"...","subject":"...","mutation":"what was disabled",
              "why_it_matters":"what a real regression here would look like"}],
 "killed":<n>,
 "unmutatable":[{"file":"...","reason":"..."}],
 "verdict":"clean|findings|void",
 "void_reason":"<required when verdict is void, omit otherwise>"}
```

`verdict` is **void** if any mutation could not be restored, if the test command could not run (missing
dependencies, missing toolchain), or if it failed for reasons unrelated to your mutation. **Void is a real
answer** — a routine that could not measure must never report "clean". Only `clean` is treated as silence;
every other value, including a word not in this list, raises a finding.

Write the file even when the answer is `clean`. A run that produces no file is recorded as a failure to
measure, not as a pass.

## What happens next

`scripts/routine-audit.cjs` reads your output and turns it into a steward finding, which the 09:05 gate then
refuses to let anyone ignore until it is ruled on. The orchestrator converts real gaps into ledger tasks by
hand — deliberately not automatic, so one bad run cannot manufacture forty tasks.

**You do not decide whether a surviving mutation is worth fixing, and you do not act on it.**

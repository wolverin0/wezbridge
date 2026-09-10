<!-- doc-head: Historical command canary; see final checkpoint below; Bounded Codex and Docker isolation feasibility, 2026-09-07 -->
No-provider canary tests compare Windows Codex, WSL Codex and Docker verification boundaries.
WSL restricted-read command execution and Docker offline verification passed bounded probes; Windows unelevated read restriction is unsupported.
Includes exact executed argv, retained canary evidence and remaining worker-authentication/runtime-tool limits.
No machine settings, global ACLs, firewall, credentials, live services or provider calls were changed.
<!-- /doc-head -->

# Recommendation

Use **WSL native Codex with an explicit restricted-read permission profile for model workers**, and **the existing Docker Desktop engine for protected verification**. This keeps both boundaries native and avoids an authentication proxy or new framework. The command sandbox is proven below; a full model turn's authentication and effective tool surface remain untested. Do not claim the full worker boundary passed until the exact `exec` launch profile is checked.

The Windows unelevated native backend cannot enforce the requested restricted reads. It failed closed with `Restricted read-only access requires the elevated Windows sandbox backend`. Elevated Windows may be viable if already configured, but this spike did not run setup, elevate, or change host security.

## Observed installations

- Windows and Ubuntu WSL native Codex both report **0.153.4**. WSL requires a login shell or the explicitly resolved native executable: direct `wsl -- codex` can accidentally resolve the Windows npm shim and fail with missing Linux optional dependency.
- WSL Node is **24.14.1**. The absence of a system `bwrap` is not a blocker: native Codex supplied its own bubblewrap sandbox.
- Docker server reports **29.7.2**. Existing image `node:24-bookworm-slim` is `sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e`. No pull/build/install occurred. Docker was invoked from Windows; WSL Docker integration was not enabled.
- Local `codex exec --help` explicitly supports `--ignore-user-config` and says auth still uses `CODEX_HOME`; `--ignore-rules` and `--ephemeral` also exist. These are useful isolation inputs, not proof that every automatic tool/skill/instruction surface is disabled.

## Canary results

All inputs were synthetic files under `G:/tmp/autonomy-isolation-canaries-20260907`. The fake-auth file contains only a synthetic marker, never a real token. Retained evidence: `candidate/probe.cjs`, `native-home/config.toml`, `linux-home/config.toml`, `native-result.json`, `linux-result.json`, `docker-result.json`.

| Probe | WSL native restricted profile | Docker verifier |
|---|---|---|
| Read assigned candidate | Allowed | Allowed |
| Write assigned candidate | Allowed | EROFS, as verifier requires |
| Read protected oracle | Allowed | Allowed |
| Write protected oracle | EROFS | EROFS |
| Read sibling fake-auth file | ENOENT, not exposed | ENOENT, not mounted |
| Write sibling fake-auth file | ENOENT | ENOENT |
| Connect to TEST-NET canary address | EPERM | ENETUNREACH |
| Write host sibling sentinel | Host remained unchanged | EROFS |

WSL's `outside_root_write` probe returns `ALLOWED` because it can create a file in a **sandbox-private scaffold directory**. Direct host reads afterward confirmed the actual outside sentinel, private fake-auth and oracle were unchanged. This is not proof that every path outside the workspace is unwritable inside the sandbox namespace; it is evidence that the corresponding unmounted host data was not exposed or modified. Do not mislabel this probe.

The Docker container was `--rm`; the named canary container was absent after completion. No provider/model call or real auth read occurred.

## Exact executed profiles and argv

### Windows negative result

An owned clean `CODEX_HOME` pointed at `native-home`. Profile permitted `:minimal` read, candidate write, oracle read, with network disabled and `windows.sandbox="unelevated"`.

```text
cmd.exe /d /c codex.cmd sandbox -P autonomy-canary -C G:\tmp\autonomy-isolation-canaries-20260907\candidate -- "C:\Program Files\nodejs\node.exe" probe.cjs
```

Exit 1 before command execution. No elevated-backend experiment followed.

### WSL positive result

`linux-home/config.toml` contains the exact tested paths, including the installed **Codex vendor bin directory** as a read root. This extra runtime grant is essential: the first attempt with only `:minimal` failed when bubblewrap could not exec the internal Codex binary. The successful profile has no global `:root` read grant and no inherited `:workspace` profile:

```toml
default_permissions = "autonomy-canary"
[permissions.autonomy-canary.filesystem]
":minimal" = "read"
"<actual-installed-codex-vendor-bin>" = "read"
"/mnt/g/tmp/autonomy-isolation-canaries-20260907/candidate" = "write"
"/mnt/g/tmp/autonomy-isolation-canaries-20260907/oracle" = "read"
[permissions.autonomy-canary.network]
enabled = false
```

Exact executed command (native executable resolved by the login shell):

```powershell
wsl -d Ubuntu -- bash -lc 'env CODEX_HOME=/mnt/g/tmp/autonomy-isolation-canaries-20260907/linux-home CANARY_BASE=/mnt/g/tmp/autonomy-isolation-canaries-20260907 CANARY_ORACLE=/mnt/g/tmp/autonomy-isolation-canaries-20260907/oracle/oracle.txt CANARY_PRIVATE=/mnt/g/tmp/autonomy-isolation-canaries-20260907/private/fake-auth.txt codex sandbox -P autonomy-canary -C /mnt/g/tmp/autonomy-isolation-canaries-20260907/candidate -- /usr/bin/node probe.cjs'
```

Installed 0.153.4 uses `codex sandbox [OPTIONS] -- COMMAND`; do **not** insert a `linux` subcommand. A documentation-style `codex sandbox linux` attempt treated `linux` as the executable and failed before the probe. Local help outranks that older command example.

### Docker positive result

`$root` below is the exact owned canary directory. The existing image was used without pulling; pin the inspected image ID for later acceptance runs.

```powershell
$root='G:\tmp\autonomy-isolation-canaries-20260907'
docker run --rm --pull never --name autonomy-isolation-canary-20260907 --network none --cap-drop ALL --security-opt no-new-privileges --read-only --pids-limit 32 --memory 128m --cpus 0.5 --user 65534:65534 --tmpfs /tmp:rw,nosuid,noexec,size=16m --mount "type=bind,source=$root\candidate,target=/candidate,readonly" --mount "type=bind,source=$root\oracle,target=/oracle,readonly" --workdir /candidate --env CANARY_BASE=/ --env CANARY_ORACLE=/oracle/oracle.txt --env CANARY_PRIVATE=/private/fake-auth.txt node:24-bookworm-slim node probe.cjs
```

For the actual verifier, mount immutable candidate and oracle separately read-only, invoke the fixed oracle entry point, and capture stdout from the parent into an owned artifact. Do not mount the controller DB, host home, Docker socket or credentials. If a test needs temporary files, use the bounded container tmpfs. No host output mount is necessary for stdout evidence. Browser tests need an appropriate already-vetted image/dependencies; this Node canary does not certify a browser image.

## Model-worker integration: supported shape, not yet exercised

Keep the privileged Codex client on WSL using its normal existing auth mechanism; do not copy/extract tokens into a container or create an auth proxy. Feed the restricted policy as explicit `-c` overrides while using `exec --ignore-user-config --ephemeral`; the CLI parent may authenticate while sandboxed commands see only granted roots. Do **not** retain the old `--sandbox workspace-write` argument when using named permissions: it overrides the newer permissions profile. Current official docs describe profile read/write/deny rules, platform support and this precedence. [Permissions](https://learn.chatgpt.com/docs/permissions)

Suggested fixed argv shape, **not executed because it would call a model**:

```text
codex exec --json --ephemeral --ignore-user-config -C <owned-linux-candidate-root> -c approval_policy="never" -c default_permissions="autonomy" -c 'permissions.autonomy.filesystem={":minimal"="read","<installed-codex-vendor-bin>"="read","<candidate-root>"="write","<approved-context-root>"="read"}' -c permissions.autonomy.network.enabled=false -
```

Use argument arrays, not string-built shell commands. Launch with a minimal environment containing necessary executable/runtime/home variables and the already supported auth selection, not arbitrary controller env vars. Add each dependency/tool read root deliberately; never make the entire host project tree readable for convenience. Freeze task context before launch, including applicable trusted instructions; do not load uncontrolled project `.codex` configuration from arbitrary intake paths.

App Server additionally documents explicit `readOnlyAccess={type:"restricted",includePlatformDefaults:true,readableRoots:[...]}` for `workspaceWrite`, plus sandboxed `command/exec`. This is a supported future native path, but adopting App Server is unnecessary for the proven CLI command profile and would enlarge this spike. [App Server](https://learn.chatgpt.com/docs/app-server)

**Still unknown:** successful model auth using that exact launch; effective hooks/MCP/plugins/native file tools under `--ignore-user-config`; cross-tool denial, rather than just command sandbox denial; Windows elevated backend readiness; candidate Git commit behavior with restricted `.git`/gitdir rules; required dependency roots for real projects; browser rendering inside an isolated verifier. Check these with a single bounded synthetic worker and canaries under the mission's existing model-run authority. A minimal isolated Git fixture should be validated before moving the engine's real workers to WSL; do not point the pilot at production repositories.

## Follow-up: Git and system tools

The same WSL profile's `:minimal` grant permits `/usr/bin/node`, `/usr/bin/git` **2.43.0**, `/bin/sh`, and their required dynamic libraries; no broad system-tree grant was added. An owned `candidate/git-fixture` was initialized, staged, committed with explicit synthetic identity and `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, and checked clean. Direct sandboxed `git log` returned the created commit. Evidence is `linux-git-result.json` and `linux-toolchain-result.json`.

**Runtime caveat:** nested Node `spawnSync` returned both exit 0/expected stdout and `error.code=EPERM`, with or without a timeout, for Git and shell commands. The operations occurred, but this error must not be ignored by an acceptance runner. Direct `codex sandbox ... -- /usr/bin/git ...` succeeded normally. This strengthens the recommendation to use Docker for protected verification, or test the exact direct WSL command launcher separately; it is not a reason to disable sandbox restrictions. The controller itself runs outside the child sandbox and should keep its responsive async process supervision.

The canary Git fixture resides on the allowed mounted drive. This proves the toolchain and restricted profile, not the future Linux-native worktree layout. Keep controller/worktree metadata together on the chosen Unix filesystem as proposed by the root implementation, then run one exact native-path fixture.

No global security or configuration writes were made. Codex-owned temporary sandbox state, configuration and synthetic inputs were confined to the allowed canary root. Only this report and the allowed disposable files were authored.

## Final root checkpoint, 2026-09-07

The original proposed launch above was corrected to preserve existing exec rules; no --ignore-rules flag is used. Named permission profiles must not be combined with legacy --sandbox. Current source is src/autonomy/isolation.ts in the native pilot worktree; commands here remain spike evidence, not instructions to bypass runtime gates.

Subsequent Linux Git metadata canaries denied pointer overwrite/unlink/rename/atomic replacement. Worker metadata is read-only; the trusted controller commits allowlisted regular files under an immediate SQLite authority transaction. Actual provider/image/tool isolation is still unverified:two authenticated canaries failed before a thread with cloud-config timeout. WSL offline commands recovered after a service-timeout episode, but default and forced-IPv4 HTTPS probes continue to time out. All127 Node tests pass on the Linux source copy, which does not establish provider connectivity.

A later probe of Windows' already configured elevated backend allowed the dummy private read; it failed the required isolation criterion. The server's existing namespace probe was denied. Neither fallback is accepted, and no global security or network changes were made. CORE-REVIEW.md and EVIDENCE.md contain final local verification; live jobs and supervised operation remain pending.
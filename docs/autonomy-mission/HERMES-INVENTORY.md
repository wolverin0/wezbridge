<!-- doc-head: T-0418 adult Hermes runtime inventory and thin Codex integration -->
Read-only evidence for CODEX_AUTONOMY_MISSION, observed 2026-09-07 from 22:10 UTC.
Covers adult Hermes, Telegram ownership, native cron/delegation, MemoryMaster, and a thin FinalOrchestra adapter.
Runtime activation, job execution, notification delivery, and Codex runtime compatibility remain untested here.
<!-- /doc-head -->

# Adult Hermes inventory — T-0418

**Recommendation:** keep the existing FinalOrchestra Codex/SQLite kernel as the durable job owner. Add a narrow Hermes plugin or MCP tool facade for submit/status/cancel; return the durable job ID immediately. Use Hermes' existing outbound send path for authorized status notifications. Do not switch the main Hermes conversation onto its optional Codex runtime for this pilot.

## Verified installation and runtime

| Item | Evidence |
|---|---|
| Host and identity | Existing infra-authorized Ubuntu VM SSH access, adult user's account. No SSH alias for this VM in the Windows config; the documented dedicated key works. Private network address omitted. |
| Unit | `systemctl --user show hermes-gateway.service`: loaded, active, running; PID `696797`; active since `2026-09-06 00:35:09 -03`. |
| Executable | `~/.hermes/hermes-agent/venv/bin/python -m hermes_cli.main gateway run`; working directory `~/.hermes`. Process `HERMES_HOME` equals this root. |
| Loaded/source identity | `~/.hermes/gateway_state.json` reports the same PID, version `0.21.0`, SHA `9dd6634c5635321cf38840cc30e9b51226689128`. Source `pyproject.toml:5`, `hermes_cli/__init__.py:6`, and git HEAD match. State metadata last updated `2026-09-07T20:51:18Z`; current systemd state independently checked. |
| Companion services | Adult `hermes-serve.service` active/running; `hermes-control-interface.service` inactive/dead. The serve unit supplies the desktop/remote JSON-RPC/WebSocket backend. |
| Config location | VM `~/.hermes/config.yaml`, `~/.hermes/.env`, and `~/.hermes/profile.yaml`. Desktop `%LOCALAPPDATA%/hermes/config.yaml` also exists; it is not the file selected by the verified VM gateway process. |
| Read-only SSH gotcha | Noninteractive SSH omitted the user-bus environment. Setting `XDG_RUNTIME_DIR=/run/user/<uid>` for the read-only `systemctl --user` subprocess resolved it. Empty stdout without checking stderr would have falsely suggested no unit. |

Infra pointers consulted before remote access: `infra/AGENTS.md`, `CLAUDE.md`, `docs/DOCS-MAP.md`, `PLACEMENT.md`, targeted Hermes portions of `SYSTEM.md`, `CROSS-PANE-STATUS.md`, `docs/INVENTORY.md`, and `docs/SCHEDULES.md`. Remote source `AGENTS.md` explicitly prefers extending existing code, CLI/skill, service-gated tool, plugin, then MCP over adding core infrastructure.

## Telegram consumer and owner mapping

- Read-only Bot API `getMe` confirms the adult token identifies `@Pdashboard_bot`. `getWebhookInfo` returns no webhook and zero pending updates. No `getUpdates`, messages, or attachments were requested.
- One matching adult-user `hermes_cli.main gateway run` process was found; its cwd is the adult Hermes root. Runtime state lists `telegram`, `api_server`, `homeassistant`, and `pane_bridge` as connected. Native Telegram source `plugins/platforms/telegram/adapter.py:1688` starts polling.
- These observations establish the expected local consumer and no webhook. They do **not** prove no competing consumer exists on every other host or demonstrate successful delivery of a new message.
- `telegram.bot_token` is present and equals the `.env` `TELEGRAM_BOT_TOKEN`. `TELEGRAM_ALLOWED_USERS` contains two identities. The configured `PANE_BRIDGE_TELEGRAM_USER_ID` belongs to that allowlist, equals its configured private chat ID, and that chat equals `TELEGRAM_HOME_CHANNEL`. All numeric identities are deliberately omitted. The second allowed identity is not automatically authorized to submit autonomy jobs.
- Relevant names present: `PANE_BRIDGE_SECRET`, `PANE_BRIDGE_TELEGRAM_CHAT_ID`, `PANE_BRIDGE_TELEGRAM_USER_ID`, `PANE_BRIDGE_TELEGRAM_CHAT_TYPE`, `TELEGRAM_ALLOWED_USERS`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_HOME_CHANNEL`, `TELEGRAM_HOME_CHANNEL_THREAD_ID`. No values were exported.

## Existing native state and extension points

| Surface | Installed evidence and limit |
|---|---|
| Profiles | Sixteen adult profile directories, each with `config.yaml`: autoresearch, personal, main, mission-control, meta, general, research, bot-hr, leads, saleor-ml, wisp-dev, self-audit, infra, dev, polymarket, vibe-digest. No jobs found in their profile-local cron files. Directory existence does not establish active routing. |
| Cron | Default `~/.hermes/cron/jobs.json`: 62 jobs, 11 enabled; states 50 paused, 11 scheduled, 1 completed. Five enabled jobs use `no_agent`, six use agent execution. Active last-status counts: 9 `ok`, 1 `error`, 1 unset. Existing jobs were neither named publicly nor altered. |
| Durable execution history | `cron/executions.db` contains `executions` and `cron_incidents`; the execution schema includes owner PID/start fingerprint, claim/start/finish times, terminal status, and handoff flags. Precise rolling 24-hour query using `julianday` found 16 completed and 3 failed attempts. This is historical execution evidence, not proof of a new pilot or all deliveries. |
| Scheduler activity | `ticker_heartbeat` and `ticker_last_success` mtimes were `2026-09-07T22:11:02Z`. Native job creation accepts `enabled_toolsets`, absolute `workdir`, and `no_agent` (`cron/jobs.py:1691-1693`). `cron/scheduler.py:1252` implements script-only execution; agent-managed scheduling defaults off unless configured (`:395-401`). Current online docs may contain features newer than this installed SHA. |
| Inboxes/ledgers | `pending_messages/` empty; `spawn-ledger.json` holds eight entries. `bot_relay/` has claimed/outbox/replies and a roster. These are existing surfaces; message bodies and customer content were not read, and no external durable-job contract was established for them. |
| Background delegation | `tools/delegate_tool.py:348-357` supports `background`, returning a dispatch handle, plus `list`, `steer`, and `stop`. It requires a parent agent. Its caller-supplied `max_iterations` is ignored in favor of configured limits (`:388-395`). Execution uses daemon thread pools (`delegate_tool_dispatch.py:97-118`); this is not evidence of a restart-safe external Codex job owner. |
| Plugins/MCP | Native plugin registration supplies hooks, tools and CLI commands (`plugins/AGENTS.md:37`). Config contains `mcp_servers` entries for memorymaster, jarvis, composio, obscura, super-productivity, and disabled pd. No dedicated bounded Codex queue facade was identified. Tool discovery/authentication was not invoked. |

The current [official cron documentation](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron/) confirms native one-shot/recurring jobs, local/platform delivery, no-agent scripts, and an execution ledger; it also distinguishes execution failure from delivery failure. The [official plugin documentation](https://hermes-agent.nousresearch.com/docs/user-guide/features/plugins/) describes tools and lifecycle extensions. Installed source takes precedence where versions differ.

## Existing bridge versus notifications

`~/.hermes/plugins/pane_bridge/plugin.yaml` declares version `1.0.0`, platform kind. The runtime state reports it connected. Its route is `POST /api/platforms/pane_bridge/events`; `adapter.py:90-100` verifies a scoped bearer using constant-time comparison. Target user/chat come from fixed configuration, not arbitrary request targets.

`dispatch_http_event` (`adapter.py:102-149`) schedules `deliver_wake` into the live Telegram conversation. HTTP `accepted` precedes processing; the resulting agent reply is its completion evidence. **It wakes a model turn and is inbound Wezbridge-to-Hermes transport. It is neither an external Codex job dispatcher nor a notification-only route.**

For authorized status-only notifications, installed `hermes_cli/send_cmd.py:249-271` defines `hermes send`: text/file/stdin input, existing configured platform credentials, no LLM or agent loop, and no running gateway required for token-backed Telegram delivery. `tools/send_message_tool.py:472-483` dispatches Telegram to `_send_telegram`. This path needs no second update consumer. It was inspected, not executed. A real sender must check structured `success`/`skipped` and delivery evidence, rather than treating exit code zero alone as proof: `send_cmd.py:72-73` also returns zero for skipped sends.

## Native Codex runtime comparison

The installed tree includes `agent/codex_runtime.py`, `agent/transports/codex_app_server*.py`, and `hermes_cli/codex_runtime_switch.py`. The default config has no `model.openai_runtime` opt-in. VM `codex --version` reports `codex-cli 0.125.0`; a Codex auth file exists, but login validity was not tested.

The [official Hermes Codex runtime page](https://hermes-agent.nousresearch.com/docs/user-guide/features/codex-app-server-runtime) calls the runtime opt-in, requires Codex CLI 0.130.0 or newer, and says cron on that runtime is not specifically tested. It also excludes Hermes `delegate_task`, `memory`, `session_search`, and `todo` from the stateless callback. Consequently, this installation is **not verified compatible or ready** for that path. Enabling it would change the conversation execution engine and require an upgrade/compatibility exercise; it is a larger pilot than an external queue tool.

## Smallest pilot and acceptance gates

1. Keep FinalOrchestra's existing Codex process/SQLite ledger authoritative, subject to the root agent's live verification. No Hermes cron table, kanban board, or inbox should become a duplicate master backlog.
2. A narrow adult-Hermes plugin or MCP facade exposes `submit_job`, `job_status`, and `cancel_job` against that kernel's existing local/HTTP contract. Submission performs validation/enqueue only, uses a short timeout, and returns an immutable job ID. Poll/cancel likewise return promptly. Generic Hermes extension surfaces support this shape; the exact FinalOrchestra endpoints and cancellation/recovery guarantees remain for its owner to verify.
3. Enforce operator identity on authenticated session source, project/workdir allowlist, explicit authorized job type, idempotency key, bounded execution budget/time, concurrency ceiling, and cancellation at the durable owner. Do not trust instructions in retrieved content or a synthetic pane message as fresh operator authority. Do not rely on the two-person Telegram allowlist alone.
4. Initial task can be a read-only repository report with local artifacts. Kernel state transitions remain canonical; a deduplicated notifier may use the existing adult `hermes send` path only when external delivery is authorized. Polling status should not wake a model turn.
5. Before activation, prove locally: queue acceptance is distinct from completion; duplicate submissions do not spawn twice; cancellation stops owned work; restart recovery preserves terminal truth; pending/running/error/result map consistently into Hermes; notifications do not loop back into job creation. Live plugin loading or gateway restart, actual Codex execution/spend, and test notifications require the corresponding mission authority and verification.

## MemoryMaster

Existing VM config includes `mcp_servers.memorymaster` and `memorymaster_bridge` keys for recall budget/limit/timeout, context cap, scopes, sync-first, and distillation. Plugin manifests: `memorymaster` 0.1.0 (session-end/switch, pre-compress and memory-write hooks) and `memorymaster-bridge` 0.1.0 (session-start, pre/post-LLM hooks). The recall/distillation settings are present and truthy. `memorymaster-outbox.db` exists. OS crontab invokes `/opt/memorymaster/scripts/hermes-sync.sh` at 03:00 and 15:00 host cron time. Registration/configuration does not prove successful sync or correct scope isolation; no sync was run.

No configuration, unit, credential, schedule, profile, job, or repository was changed. No services restarted; no installs, spending, external messages, or child-Hermes inspection occurred. Only this report was written.

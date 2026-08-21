# pane_bridge — deploy + validate

> Greppable head: Hermes plugin that injects a WezBridge-pane message into the
> LIVE Jarvis Telegram session as a participant (native `deliver_wake` path),
> reply delivered through Telegram. Scoped secret, zero core patch. Read when:
> deploying the Pane-0↔Jarvis bridge, or debugging why a send-only relay was
> never received. Deploy target: the Hermes gateway on the Ubuntu VM
> (192.168.100.186), where the api_server listens on :8642.

## Why the old relay failed
`hermes send` / the `:8767` `/message` bridge emit an **outbound Telegram bot
message**. A bot never receives its own posts, so the Jarvis agent could not
perceive or reply. HTTP `{"status":"delivered"}` proved bridge acceptance, not
conversational delivery.

## The mechanism (native, verified)
`gateway/wake.py :: deliver_wake` — for push adapters (Telegram) it injects a
synthetic `MessageEvent(internal=True)` through `telegram_adapter.handle_message`.
That runs a turn **inside the live session** (same session key from
platform+chat_id, full history) and the reply flows out **through Telegram**.
It is an in-process call, so we expose it via a plugin that reuses the stock
`POST /api/platforms/{platform}/events` ingress (auth = the adapter's own
verifier, **not** the master API_SERVER_KEY).

## Files
- `adapter.py`  → VM `~/.hermes/plugins/pane_bridge/adapter.py`
- `plugin.yaml` → VM `~/.hermes/plugins/pane_bridge/plugin.yaml`
- pane-side caller: `wezbridge/scripts/hermes-jarvis-inject.cjs` (stays on wolverin0)

## Deploy (on the VM — needs VM shell + one gateway restart; operator-gated)
1. Copy the plugin:
   ```
   mkdir -p ~/.hermes/plugins/pane_bridge
   cp adapter.py plugin.yaml ~/.hermes/plugins/pane_bridge/
   ```
2. Generate a FRESH scoped secret (never reuse the gateway/API_SERVER key):
   ```
   SECRET=$(openssl rand -hex 32)
   ```
3. Put the scoped config where the gateway PROCESS's `os.environ` actually
   sees it. **CRITICAL — verify the real env source first:** on this VM the
   systemd unit loads `~/.config/hermes/<plugin>.env` via `EnvironmentFile=`
   and does NOT export `~/.hermes/.env` into `os.environ`. The gateway reads
   `~/.hermes/.env` internally for its own config, but the plugin reads via
   `os.getenv`, so keys placed only in `~/.hermes/.env` are invisible to it
   (measured 2026-08-21: 0 of those keys in the live process environ). The
   working pattern (memorymaster's live precedent on this box):
   ```
   # a) own env file, mode 600
   ~/.config/hermes/pane-bridge.env :
     PANE_BRIDGE_SECRET=$SECRET
     PANE_BRIDGE_TELEGRAM_CHAT_ID=<jarvis chat_id>
     PANE_BRIDGE_TELEGRAM_USER_ID=<operator telegram user_id>
     PANE_BRIDGE_TELEGRAM_CHAT_TYPE=dm        # dm if chat_id == user_id, else group
     # PANE_BRIDGE_TELEGRAM_THREAD_ID=<topic id>   # only if a forum topic
   # b) systemd drop-in so the gateway process inherits it
   ~/.config/systemd/user/hermes-gateway.service.d/pane-bridge.conf :
     [Service]
     EnvironmentFile=%h/.config/hermes/pane-bridge.env
   # c) reload + restart
   systemctl --user daemon-reload
   ```
   Find the chat_id/user_id from the gateway's telegram env
   (TELEGRAM_HOME_CHANNEL / TELEGRAM_ALLOWED_USERS) or session store — do NOT
   guess. If chat_id == user_id it is a DM; set CHAT_TYPE=dm.
   To confirm the process really sees the vars, read /proc/<gatewayPID>/environ
   — a "configured" file the process does not read is NOT delivered.
4. Register the secret in Vaultwarden (infra CLAUDE.md §2) — not just the .env.
5. Restart ONLY the gateway to load the plugin (does not disable the local
   Desktop agent; does briefly interrupt telegram polling — expected):
   ```
   systemctl --user restart hermes-gateway    # or hermes gateway restart
   ```
   Confirm registration with the negative-control probe: a BAD token to
   `/api/platforms/pane_bridge/events` returns 401/403 when the adapter is
   registered, but 503 "Platform adapter is not connected" (same as an
   invented platform name) when it is not. Also `hermes plugins list` should
   show `pane_bridge | enabled | user`.
6. Transfer the same secret to wolverin0 without display, into an ACL-locked
   file (mirrors the existing .hermes-bridge convention):
   `%USERPROFILE%\.hermes-bridge\pane-bridge.secret` (single line, no newline),
   ACL: pauol + SYSTEM only.

## Validate end-to-end (do NOT claim success before this)
From wolverin0 (a WezBridge pane):
```
node "G:\_OneDrive\OneDrive\Desktop\Py Apps\wezbridge\scripts\hermes-jarvis-inject.cjs" "PANE-0 BRIDGE TEST <timestamp>: reply with the word ACKJARVIS."
```
Success criteria (all four):
1. HTTP status 2xx with `{"status":"accepted"}`.
2. The tagged message `[Pane-0 · wezbridge] PANE-0 BRIDGE TEST …` appears in the
   Telegram chat.
3. Jarvis produces a real reply **in that same Telegram chat** (e.g. contains
   ACKJARVIS).
4. Evidence captured: the HTTP body + the Telegram message id / reply text (or a
   screenshot / an independently verifiable Telegram delivery id).

## Security notes
- Auth is `hmac.compare_digest(token, PANE_BRIDGE_SECRET)`; master key never used.
- The target chat + user are fixed by env, so the scoped secret can only speak
  into the configured Jarvis conversation, not arbitrary chats.
- Rotate `PANE_BRIDGE_SECRET` if it ever transits a prompt/chat/log.
- Rotate the legacy `:8767` bearer too — it transited chat earlier on 2026-08-21.

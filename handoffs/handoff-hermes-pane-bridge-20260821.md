# Handoff — Hermes Pane-0 ↔ Jarvis bidirectional bridge, 2026-08-21

> 7-line greppable head: Native Hermes bridge so a trusted WezBridge pane
> injects a tagged message into the LIVE Jarvis Telegram session as a
> participant, reply delivered through Telegram. Root cause of prior failure:
> send-only relay (bot can't receive its own posts). Solution: `pane_bridge`
> plugin reusing POST /api/platforms/{platform}/events + gateway.wake.deliver_wake.
> Status: CODE COMPLETE, NOT yet deployed/validated (needs VM deploy + gateway
> restart + scoped secret + operator's Telegram chat_id/user_id). Corr: hermes-pane-bridge-20260821.

## The failure this fixes
Prior handling (mine and earlier) treated the `:8767` `/message` bridge's
`{"status":"delivered"}` as conversational delivery. It is not: that bridge only
emits an OUTBOUND Telegram bot message, which a bot never receives — so Jarvis
could never see or reply to it. Verified by source, not assumption.

## Source investigation (files read on wolverin0 `~/.hermes/hermes-agent`)
- `gateway/wake.py` — `deliver_wake`: push adapters (Telegram) get a synthetic
  `MessageEvent(internal=True)` via `handle_message` → live-session participant
  turn, reply out through the platform. `internal=True` bypasses the
  unauthorized-user drop gate (run.py:10149 / #17775). THIS is the primitive.
- `gateway/platforms/api_server.py` — route table: `POST /api/platforms/{platform}/events`
  (`_handle_platform_event_callback`) authenticates via the adapter's own
  `verify_http_event_request` (NOT API_SERVER_KEY) and dispatches via
  `dispatch_http_event`. This is the scoped, non-master-key HTTP ingress.
- `api_server` session/chat (`/api/sessions/{id}/chat`) runs a turn but replies
  ONLY to the HTTP caller — NOT through Telegram. Rejected for this use.
- webhook `deliver: telegram` (`_deliver_cross_platform`) does `adapter.send(...)`
  — an outbound send from a SEPARATE session, not a participant turn. Rejected.
- Telegram adapter (`plugins/platforms/telegram/adapter.py`) does NOT implement
  `dispatch_http_event`, so `/api/platforms/telegram/events` 503s — hence a
  dedicated `pane_bridge` adapter is required to own the ingress.

## What was built (in this repo, source of record)
- `integrations/hermes-pane-bridge/adapter.py` — `PaneBridgeAdapter`
  (BasePlatformAdapter). `verify_http_event_request` = hmac.compare_digest
  against `PANE_BRIDGE_SECRET`; `dispatch_http_event` = build SessionSource for
  the configured Telegram chat + `deliver_wake` on the live telegram adapter
  (scheduled as a task so HTTP returns fast). Zero core changes.
- `integrations/hermes-pane-bridge/plugin.yaml` — platform plugin manifest.
- `integrations/hermes-pane-bridge/DEPLOY.md` — deploy + 4-point validation.
- `scripts/hermes-jarvis-inject.cjs` — pane-side caller → `/api/platforms/pane_bridge/events`,
  scoped secret from ACL-locked `%USERPROFILE%\.hermes-bridge\pane-bridge.secret`.

## Remaining to reach "success" (all operator/VM gated)
1. Deploy the plugin to the VM `~/.hermes/plugins/pane_bridge/` (infra has VM access).
2. Set env: `PANE_BRIDGE_SECRET` (fresh, NOT the master key), `PANE_BRIDGE_TELEGRAM_CHAT_ID`,
   `PANE_BRIDGE_TELEGRAM_USER_ID`. Register secret in Vaultwarden (§2).
3. Restart the gateway (interrupts telegram polling briefly; does NOT disable the
   Desktop agent). Operator-gated.
4. Transfer the scoped secret to `%USERPROFILE%\.hermes-bridge\pane-bridge.secret`.
5. Run the inject test; confirm the tagged message + a real Jarvis reply appear
   in the Telegram chat. Capture HTTP body + Telegram message/reply id.

## For Jarvis
The bridge is a *participant injection*, not a bot send. When it fires you will
receive a message prefixed `[Pane-0 · wezbridge]` as a normal inbound turn in
our shared Telegram session, and your reply will go back to that same chat.
Inspect `integrations/hermes-pane-bridge/adapter.py` for the exact source/route.

Corr: hermes-pane-bridge-20260821

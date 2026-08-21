"""pane_bridge — a Hermes platform plugin that lets a trusted WezBridge pane
inject a tagged message into the LIVE Telegram/Jarvis session as a real
conversational participant, with the agent's reply delivered back through
Telegram.

WHY THIS EXISTS (the failure it fixes):
  The old relay called only `hermes send` → an OUTBOUND Telegram BOT message.
  A Telegram bot never RECEIVES its own outbound posts, so the Jarvis agent
  could never perceive or reply to them. HTTP "delivered" from the send bridge
  proves bridge acceptance, not conversational delivery.

THE NATIVE MECHANISM (verified in gateway/wake.py):
  For push-capable adapters (Telegram), `deliver_wake` injects a synthetic
  MessageEvent(internal=True) through `telegram_adapter.handle_message`. That
  runs a turn INSIDE the live session (get_or_create_session resolves the same
  key from platform+chat_id), with full history, AND the reply flows out
  through the Telegram adapter's normal reply path. `internal=True` also
  bypasses the unauthorized-user drop gate (#17775), but we still stamp the
  operator's user_id on the source so session routing is correct.

WHY A PLUGIN AND NOT A CORE PATCH:
  `deliver_wake` is an in-process call — it needs the live Telegram adapter
  OBJECT, which only exists inside the gateway. No stock HTTP endpoint exposes
  it for Telegram. But the gateway already ships a generic ingress —
  `POST /api/platforms/{platform}/events` — that authenticates via the target
  adapter's OWN `verify_http_event_request` (NOT the master API_SERVER_KEY) and
  dispatches via its `dispatch_http_event`. Registering this adapter under the
  name `pane_bridge` gives us `/api/platforms/pane_bridge/events` for free,
  guarded by our own scoped secret. Zero changes to core Hermes.

SECURITY:
  - Auth is a scoped bearer PANE_BRIDGE_SECRET, compared with hmac.compare_digest.
    The master gateway/API_SERVER key is never involved.
  - The target chat + operator user id are fixed by env (PANE_BRIDGE_TELEGRAM_*),
    so a caller with the scoped secret can only speak into the configured
    Jarvis conversation, not arbitrary chats.
"""

from __future__ import annotations

import hmac
import logging
import os
from typing import Any, Dict, Optional, Tuple

from gateway.config import Platform
from gateway.platforms.base import BasePlatformAdapter

logger = logging.getLogger(__name__)

TAG = "[Pane-0 · wezbridge]"


def _env(name: str, default: str = "") -> str:
    return (os.getenv(name) or default).strip()


class PaneBridgeAdapter(BasePlatformAdapter):
    """Receive-only relay adapter: no transport of its own; it forwards HTTP
    events into the live Telegram session and lets Telegram carry the reply."""

    def __init__(self, config: Any = None) -> None:
        super().__init__(config, Platform("pane_bridge"))
        self._secret = _env("PANE_BRIDGE_SECRET")
        self._tg_chat_id = _env("PANE_BRIDGE_TELEGRAM_CHAT_ID")
        self._tg_user_id = _env("PANE_BRIDGE_TELEGRAM_USER_ID")
        self._tg_chat_type = _env("PANE_BRIDGE_TELEGRAM_CHAT_TYPE", "group")
        self._tg_thread_id = _env("PANE_BRIDGE_TELEGRAM_THREAD_ID") or None
        # gateway_runner is injected by the runner after construction
        # (same contract the webhook adapter uses for cross-platform delivery).
        self.gateway_runner = None

    # --- BasePlatformAdapter required surface (this adapter has no transport) ---
    async def connect(self, *, is_reconnect: bool = False) -> bool:
        # "Connected" means configured enough to relay. We hold no socket.
        return bool(self._secret and self._tg_chat_id)

    async def disconnect(self) -> None:
        return None

    async def send(self, chat_id: str, content: str, *, metadata: Any = None, **kwargs) -> Any:
        # pane_bridge never sends on its own channel — replies go via Telegram.
        logger.debug("[pane_bridge] send() is a no-op; replies route through Telegram")
        return None

    async def get_chat_info(self, chat_id: str) -> Dict[str, Any]:
        return {}

    # --- HTTP-event ingress (consumed by /api/platforms/pane_bridge/events) ---
    def verify_http_event_request(self, auth_header: str) -> Tuple[bool, str]:
        if not self._secret or not self._tg_chat_id:
            return False, "pane_bridge_not_configured"
        if not auth_header.startswith("Bearer "):
            return False, "missing_bearer"
        token = auth_header[7:].strip()
        if not token:
            return False, "missing_bearer"
        if not hmac.compare_digest(token, self._secret):
            return False, "invalid_pane_bridge_secret"
        return True, ""

    async def dispatch_http_event(self, envelope: Dict[str, Any]) -> Dict[str, Any]:
        message = str(envelope.get("message") or "").strip()
        if not message:
            return {"status": "rejected", "reason": "empty message"}

        runner = self.gateway_runner
        if runner is None:
            logger.error("[pane_bridge] no gateway_runner injected")
            return {"status": "error", "reason": "no gateway runner"}

        tg_adapter = runner.adapters.get(Platform.TELEGRAM)
        if tg_adapter is None:
            # fall back to a secondary profile's telegram adapter if present
            for _prof, amap in (getattr(runner, "_profile_adapters", None) or {}).items():
                if isinstance(amap, dict) and amap.get(Platform.TELEGRAM):
                    tg_adapter = amap[Platform.TELEGRAM]
                    break
        if tg_adapter is None:
            return {"status": "error", "reason": "telegram adapter not connected"}

        from gateway.session import SessionSource
        from gateway.wake import deliver_wake

        source = SessionSource(
            platform=Platform.TELEGRAM,
            chat_id=self._tg_chat_id,
            chat_type=self._tg_chat_type,
            user_id=self._tg_user_id or None,
            thread_id=self._tg_thread_id,
        )
        tagged = f"{TAG} {message}"

        # deliver_wake's push path builds the synthetic inbound MessageEvent and
        # runs handle_message → the live Jarvis session processes it as a new
        # participant turn and replies through Telegram. We schedule it so the
        # HTTP call returns promptly; the observable proof is the Telegram reply,
        # not this HTTP body.
        import asyncio

        async def _run() -> None:
            try:
                await deliver_wake(tg_adapter, text=tagged, session_id="", source=source)
                logger.info("[pane_bridge] injected pane message into live Telegram session %s", self._tg_chat_id)
            except Exception:
                logger.exception("[pane_bridge] deliver_wake into Telegram failed")

        asyncio.create_task(_run())
        return {"status": "accepted", "target": "telegram", "chat_id": self._tg_chat_id}


def _check_for_registry(_cfg: Any = None) -> bool:
    return bool(_env("PANE_BRIDGE_SECRET") and _env("PANE_BRIDGE_TELEGRAM_CHAT_ID"))


def _is_connected(adapter: Any) -> bool:
    return bool(getattr(adapter, "_secret", "") and getattr(adapter, "_tg_chat_id", ""))


def register(ctx) -> None:
    """Plugin entry point. Registers pane_bridge so the gateway's adapter
    factory creates it and /api/platforms/pane_bridge/events resolves it."""
    ctx.register_platform(
        name="pane_bridge",
        label="Pane Bridge",
        adapter_factory=lambda cfg: PaneBridgeAdapter(cfg),
        check_fn=_check_for_registry,
        is_connected=_is_connected,
        required_env=[
            "PANE_BRIDGE_SECRET",
            "PANE_BRIDGE_TELEGRAM_CHAT_ID",
        ],
        install_hint="Set PANE_BRIDGE_SECRET + PANE_BRIDGE_TELEGRAM_CHAT_ID and restart the gateway.",
        emoji="🔉",
    )

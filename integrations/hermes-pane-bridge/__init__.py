"""pane_bridge platform plugin — package entry point.

The Hermes plugin loader imports each plugin package's __init__ and calls its
register(ctx). The actual adapter + register() live in adapter.py; this file
re-exports register so the loader finds it (same pattern as the bundled
plugins/platforms/*/__init__.py, e.g. google_chat)."""

from .adapter import register

__all__ = ["register"]

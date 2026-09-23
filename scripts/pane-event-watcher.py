#!/usr/bin/env python3
"""
pane-event-watcher.py - Reactive event stream tailer for Orca / Wezbridge.
Tails G:/_OneDrive/OneDrive/Desktop/Py Apps/_intel/pane-events.jsonl
from current end-of-file and emits formatted notifications to stdout.
Flushes stdout immediately so Antigravity background task wakes up the orchestrator.
"""

import sys
import os
import time
import json
from pathlib import Path

EVENTS_FILE = Path("G:/_OneDrive/OneDrive/Desktop/Py Apps/_intel/pane-events.jsonl")

def main():
    print(f"[WATCHER-STARTED] Listening to {EVENTS_FILE}", flush=True)
    
    if not EVENTS_FILE.exists():
        print(f"[WATCHER-ERROR] File {EVENTS_FILE} does not exist", flush=True)
        return

    # Seek to end of file to ignore past events
    with open(EVENTS_FILE, "r", encoding="utf-8", errors="replace") as f:
        f.seek(0, os.SEEK_END)
        current_pos = f.tell()
        print(f"[WATCHER-READY] Initialized at offset {current_pos}. Waiting for pane events...", flush=True)

        while True:
            line = f.readline()
            if not line:
                time.sleep(0.5)
                continue
            
            line = line.strip()
            if not line:
                continue

            try:
                ev = json.loads(line)
                repo = ev.get("repo", "unknown")
                event_type = ev.get("event", "unknown")
                session = ev.get("session", "")
                markers = ev.get("markers", [])
                message = ev.get("message", "")
                head = ev.get("head", "")
                
                # Format an alert that Antigravity can immediately understand and act upon
                alert = f"[PANE-EVENT WAKEUP] Repo: {repo} | Event: {event_type} | Session: {session}"
                if markers:
                    alert += f" | Markers: {markers}"
                if message:
                    alert += f" | Message: {message}"
                if head:
                    alert += f" | Head: {head[:8]}"
                    
                print(alert, flush=True)
            except Exception as ex:
                print(f"[PANE-EVENT RAW] {line} (err: {ex})", flush=True)

if __name__ == "__main__":
    main()

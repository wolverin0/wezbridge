#!/usr/bin/env python3
"""
pane-event-watcher.py - Reactive event stream tailer for Orca / Wezbridge.
Tails G:/_OneDrive/OneDrive/Desktop/Py Apps/_intel/pane-events.jsonl
from current end-of-file and emits formatted notifications to stdout.
Flushes stdout immediately so Antigravity background task wakes up the orchestrator.

T-0409: --kinds <comma,list> restricts output to those `event` values (e.g.
--kinds suborch_question,suborch_done,worker-done). Without the flag the watcher
keeps its ORIGINAL behaviour and echoes every event unconditionally — changing that
default is a Fleet call, not this card's (see the T-0409 scope report). For a bounded
signal instead of every raw event, see scripts/fleet-digest.cjs, which classifies
this same file into immediate/digest/drop.
"""

import argparse
import sys
import os
import time
import json
from pathlib import Path

DEFAULT_EVENTS_FILE = Path("G:/_OneDrive/OneDrive/Desktop/Py Apps/_intel/pane-events.jsonl")


def parse_kinds(raw):
    """'a,b, c' -> ['a', 'b', 'c']. Falsy input (None or '') -> None, meaning
    "no filter, keep current behaviour" — never an empty list that would silently
    filter out everything."""
    if not raw:
        return None
    kinds = [s.strip() for s in raw.split(",") if s.strip()]
    return kinds or None


def should_emit(ev, kinds):
    """kinds is None -> always emit (current/default behaviour, unchanged)."""
    if kinds is None:
        return True
    return ev.get("event", "unknown") in kinds


def format_alert(ev):
    """Same formatting the watcher has always used, extracted so it is testable
    without running the infinite tail loop."""
    repo = ev.get("repo", "unknown")
    event_type = ev.get("event", "unknown")
    session = ev.get("session", "")
    markers = ev.get("markers", [])
    message = ev.get("message", "")
    head = ev.get("head", "")

    alert = f"[PANE-EVENT WAKEUP] Repo: {repo} | Event: {event_type} | Session: {session}"
    if markers:
        alert += f" | Markers: {markers}"
    if message:
        alert += f" | Message: {message}"
    if head:
        alert += f" | Head: {head[:8]}"
    return alert


def parse_args(argv):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--kinds", default=None,
                   help="Comma-separated event kinds to print (e.g. suborch_question,worker-done). "
                        "Omit to keep printing every event (current behaviour, unchanged).")
    p.add_argument("--events-file", default=None,
                   help="Override the tailed file (mainly for tests).")
    return p.parse_args(argv)


def main(argv=None):
    args = parse_args(argv if argv is not None else sys.argv[1:])
    events_file = Path(args.events_file) if args.events_file else DEFAULT_EVENTS_FILE
    kinds = parse_kinds(args.kinds)

    print(f"[WATCHER-STARTED] Listening to {events_file}"
          + (f" (kinds filter: {kinds})" if kinds else ""), flush=True)

    if not events_file.exists():
        print(f"[WATCHER-ERROR] File {events_file} does not exist", flush=True)
        return

    # Seek to end of file to ignore past events
    with open(events_file, "r", encoding="utf-8", errors="replace") as f:
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
            except Exception as ex:
                print(f"[PANE-EVENT RAW] {line} (err: {ex})", flush=True)
                continue

            if not should_emit(ev, kinds):
                continue

            print(format_alert(ev), flush=True)


if __name__ == "__main__":
    main()

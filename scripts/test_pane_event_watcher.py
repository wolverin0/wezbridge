#!/usr/bin/env python3
"""
test_pane_event_watcher.py - T-0409 (AC5): unit tests for pane-event-watcher.py's
--kinds filter. Tests the extracted pure helpers (parse_kinds, should_emit,
format_alert) directly, never the infinite tail loop in main().

Correr:  python scripts/test_pane_event_watcher.py -v
"""

import importlib.util
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
# The module's filename has dashes (pane-event-watcher.py), so it cannot be a
# plain `import` target — loaded explicitly from its file path instead.
_SPEC = importlib.util.spec_from_file_location("pane_event_watcher", os.path.join(HERE, "pane-event-watcher.py"))
watcher = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(watcher)


class ParseKindsTests(unittest.TestCase):
    def test_comma_list(self):
        self.assertEqual(watcher.parse_kinds("suborch_question,worker-done"),
                          ["suborch_question", "worker-done"])

    def test_trims_whitespace(self):
        self.assertEqual(watcher.parse_kinds(" a , b ,c "), ["a", "b", "c"])

    def test_none_or_empty_means_no_filter(self):
        self.assertIsNone(watcher.parse_kinds(None))
        self.assertIsNone(watcher.parse_kinds(""))


class ShouldEmitTests(unittest.TestCase):
    def test_no_filter_keeps_current_behaviour_emit_everything(self):
        for ev in [{"event": "turn-end"}, {"event": "suborch_status"}, {"event": "worker-done"}, {}]:
            self.assertTrue(watcher.should_emit(ev, None), ev)

    def test_filter_only_matches_listed_kinds(self):
        kinds = ["suborch_question", "worker-done"]
        self.assertTrue(watcher.should_emit({"event": "suborch_question"}, kinds))
        self.assertTrue(watcher.should_emit({"event": "worker-done"}, kinds))
        self.assertFalse(watcher.should_emit({"event": "turn-end"}, kinds))
        self.assertFalse(watcher.should_emit({"event": "suborch_status"}, kinds))
        self.assertFalse(watcher.should_emit({"event": "permission-wait"}, kinds))

    def test_missing_event_field_never_matches_a_real_filter(self):
        self.assertFalse(watcher.should_emit({}, ["worker-done"]))


class FormatAlertTests(unittest.TestCase):
    def test_includes_repo_event_session(self):
        ev = {"repo": "wezbridge", "event": "suborch_done", "session": "abc123"}
        alert = watcher.format_alert(ev)
        self.assertIn("Repo: wezbridge", alert)
        self.assertIn("Event: suborch_done", alert)
        self.assertIn("Session: abc123", alert)

    def test_optional_fields_only_appear_when_present(self):
        bare = watcher.format_alert({"repo": "r", "event": "e", "session": "s"})
        self.assertNotIn("Markers:", bare)
        self.assertNotIn("Message:", bare)
        self.assertNotIn("Head:", bare)
        full = watcher.format_alert({
            "repo": "r", "event": "e", "session": "s",
            "markers": ["FAIL"], "message": "hi", "head": "0123456789abcdef",
        })
        self.assertIn("Markers: ['FAIL']", full)
        self.assertIn("Message: hi", full)
        self.assertIn("Head: 01234567", full)  # truncated to 8 chars


class ParseArgsTests(unittest.TestCase):
    def test_default_kinds_is_none(self):
        args = watcher.parse_args([])
        self.assertIsNone(args.kinds)

    def test_kinds_flag_is_read_verbatim_before_parse_kinds(self):
        args = watcher.parse_args(["--kinds", "worker-done,suborch_question"])
        self.assertEqual(args.kinds, "worker-done,suborch_question")


if __name__ == "__main__":
    unittest.main()

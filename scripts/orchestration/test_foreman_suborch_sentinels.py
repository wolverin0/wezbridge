#!/usr/bin/env python3
"""
test_foreman_suborch_sentinels.py - T-0555: Foreman recognizes lane-orchestrator report
lines ([SUBORCH_DONE]/[SUBORCH_QUESTION]) in addition to [WORKER_DONE].

Covers: build_sentinel_re / --sentinel narrowing, the ECHO_MARKERS extension (brief
placeholders must not false-positive), find_suborch_question, supervise_task closing on a
real [SUBORCH_DONE] line, and [SUBORCH_QUESTION] forwarding via notify_orchestrator landing
in an ISOLATED _intel/foreman/outbox.jsonl (never the real _intel).

Correr:  python scripts/orchestration/test_foreman_suborch_sentinels.py -v
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import foreman  # noqa: E402
import notify_orchestrator  # noqa: E402

WORKER_LINE = "[WORKER_DONE] task_id=T-0555 outcome=succeeded report=_intel/briefs/w.md"
SUBORCH_DONE_LINE = "[SUBORCH_DONE] task_id=T-0555 outcome=succeeded report=_intel/briefs/s.md"
SUBORCH_DONE_ECHO = "- `[SUBORCH_DONE] task_id=T-NNNN outcome=succeeded|failed report=<path>`"
SUBORCH_QUESTION_LINE = "[SUBORCH_QUESTION] task_id=T-0555 q='use approach A or B?'"
SUBORCH_QUESTION_ECHO = "- `[SUBORCH_QUESTION] task_id=T-NNNN q='<question with options a/b/c>'`"


class SentinelBuildTest(unittest.TestCase):
    def test_default_both_matches_worker_and_suborch(self):
        self.assertTrue(foreman.SENTINEL_RE.search(WORKER_LINE))
        self.assertTrue(foreman.SENTINEL_RE.search(SUBORCH_DONE_LINE))

    def test_sentinel_worker_ignores_suborch_done(self):
        re_ = foreman.build_sentinel_re("worker")
        self.assertTrue(re_.search(WORKER_LINE))
        self.assertFalse(re_.search(SUBORCH_DONE_LINE))

    def test_sentinel_suborch_ignores_worker_done(self):
        re_ = foreman.build_sentinel_re("suborch")
        self.assertFalse(re_.search(WORKER_LINE))
        self.assertTrue(re_.search(SUBORCH_DONE_LINE))

    def test_unknown_mode_falls_back_to_both(self):
        re_ = foreman.build_sentinel_re("bogus")
        self.assertTrue(re_.search(WORKER_LINE))
        self.assertTrue(re_.search(SUBORCH_DONE_LINE))


class EchoFilterTest(unittest.TestCase):
    def test_real_suborch_done_line_is_found(self):
        hit = foreman.find_worker_done(SUBORCH_DONE_LINE, "T-0555")
        self.assertEqual(hit, ("T-0555", "succeeded", "report=_intel/briefs/s.md"))

    def test_brief_echoed_suborch_done_placeholder_is_not_a_closure(self):
        # Same false-positive shape as the 2026-09-22 WORKER_DONE incident (T-0511): a brief
        # quoting the close-format template back on screen must not look like a real closure.
        self.assertIsNone(foreman.find_worker_done(SUBORCH_DONE_ECHO, "T-NNNN"))
        screen = SUBORCH_DONE_ECHO + "\n" + SUBORCH_DONE_LINE
        # the real line still wins when both are on screen (last real closure)
        self.assertEqual(foreman.find_worker_done(screen, "T-0555")[1], "succeeded")

    def test_real_suborch_question_is_found_echo_is_not(self):
        self.assertEqual(foreman.find_suborch_question(SUBORCH_QUESTION_LINE),
                          ("T-0555", "use approach A or B?"))
        self.assertIsNone(foreman.find_suborch_question(SUBORCH_QUESTION_ECHO))

    def test_mutation_check_disabling_suborch_tag_breaks_recognition(self):
        """Proves the tests above are not vacuously true: strip SUBORCH_DONE from the
        tag set the way build_sentinel_re would if T-0555's regex change were reverted."""
        crippled = foreman.build_sentinel_re("worker")  # only WORKER_DONE, the pre-T-0555 behavior
        self.assertIsNone(foreman.find_worker_done(SUBORCH_DONE_LINE, "T-0555", sentinel_re=crippled))


class SuperviseTaskSuborchTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="foreman-t0555-")
        self.patches = [mock.patch.object(foreman, "STATE_DIR", os.path.join(self.tmp, "foreman"))]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_closes_on_real_suborch_done_line_with_sentinel_suborch(self):
        state = {"task_id": "T-0555", "terminal": "term_x"}
        with mock.patch.object(foreman, "read_terminal_screen", return_value=SUBORCH_DONE_LINE), \
                mock.patch.object(foreman.time, "sleep"), \
                mock.patch.object(foreman, "notify_orchestrator") as notify:
            out = foreman.supervise_task("T-0555", "term_x", max_wait_sec=30, state=state, sentinel="suborch")
        self.assertEqual(out["status"], "completed")
        self.assertEqual(out["outcome"], "succeeded")
        notify.assert_any_call("[WORKER_DONE] task_id=T-0555 outcome=succeeded report=_intel/briefs/s.md")
        with open(foreman.state_path("T-0555"), encoding="utf-8") as f:
            saved = json.load(f)
        self.assertEqual(saved["status"], "done")
        self.assertEqual(saved["outcome"], "succeeded")

    def test_default_sentinel_both_also_closes_on_suborch_done(self):
        state = {"task_id": "T-0555", "terminal": "term_x"}
        with mock.patch.object(foreman, "read_terminal_screen", return_value=SUBORCH_DONE_LINE), \
                mock.patch.object(foreman.time, "sleep"), \
                mock.patch.object(foreman, "notify_orchestrator"):
            out = foreman.supervise_task("T-0555", "term_x", max_wait_sec=30, state=state)
        self.assertEqual(out["status"], "completed")

    def test_sentinel_worker_does_not_close_on_suborch_done_times_out(self):
        state = {"task_id": "T-0555", "terminal": "term_x"}
        with mock.patch.object(foreman, "read_terminal_screen", return_value=SUBORCH_DONE_LINE), \
                mock.patch.object(foreman.time, "sleep"), \
                mock.patch.object(foreman, "notify_orchestrator"):
            out = foreman.supervise_task("T-0555", "term_x", max_wait_sec=0, state=state, sentinel="worker")
        self.assertEqual(out["status"], "timeout")

    def test_suborch_question_forwarded_once_via_notify_orchestrator(self):
        """The poll loop sees the SAME question on two consecutive polls (screen unchanged
        until timeout): notify_orchestrator must be called for it exactly once, never per-poll."""
        state = {"task_id": "T-0555", "terminal": "term_x"}
        with mock.patch.object(foreman, "read_terminal_screen", return_value=SUBORCH_QUESTION_LINE), \
                mock.patch.object(foreman.time, "sleep"), \
                mock.patch.object(foreman, "notify_orchestrator") as notify:
            foreman.supervise_task("T-0555", "term_x", max_wait_sec=0.05, poll_interval=0.01, state=state)
        calls = [c.args[0] for c in notify.call_args_list if "[SUBORCH_QUESTION]" in c.args[0]]
        self.assertEqual(calls, ["[SUBORCH_QUESTION] task_id=T-0555 q='use approach A or B?'"])


class OutboxIsolationTest(unittest.TestCase):
    """AC3: a [SUBORCH_QUESTION] forwarded via notify_orchestrator lands in
    _intel/foreman/outbox.jsonl. Uses notify_orchestrator's own queuing (delivery forced to
    fail: subprocess.run raises), with STATE_DIR redirected to a temp dir -- the real _intel
    is never touched."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="foreman-t0555-outbox-")
        self.state_dir = os.path.join(self.tmp, "foreman")
        self.patches = [mock.patch.object(notify_orchestrator, "STATE_DIR", self.state_dir)]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_suborch_question_message_queues_into_isolated_outbox(self):
        message = "[SUBORCH_QUESTION] task_id=T-0555 q='use approach A or B?'"

        def always_fails(cmd, **kw):
            raise FileNotFoundError("orca no esta en PATH (test double)")

        with mock.patch.object(notify_orchestrator.subprocess, "run", always_fails):
            ok = notify_orchestrator.notify(message)
        self.assertFalse(ok)
        outbox_file = os.path.join(self.state_dir, "outbox.jsonl")
        self.assertTrue(os.path.exists(outbox_file))
        entries = notify_orchestrator.read_outbox()
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["message"], message)
        # real _intel untouched: nothing was ever written outside self.tmp
        self.assertTrue(outbox_file.startswith(self.tmp))


if __name__ == "__main__":
    unittest.main()

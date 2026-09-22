#!/usr/bin/env python3
"""
Unit tests for Foreman Autonomous Supervisor (scripts/orchestration/foreman.py).
Verifies state classification, redaction, and action routing.
"""

import unittest
import sys
from pathlib import Path

# Add scripts directory to path
REPO_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(REPO_ROOT / "scripts" / "orchestration"))

import foreman

class TestForemanSupervisor(unittest.TestCase):

    def test_redact_text(self):
        sample = "sk-1234567890abcdef1234567890 token: super_secret_1234 Bearer abcdef1234567890"
        redacted = foreman.redact_text(sample)
        self.assertNotIn("sk-1234567890abcdef1234567890", redacted)
        self.assertNotIn("super_secret_1234", redacted)
        self.assertIn("REDACTED", redacted)

    def test_classify_tests_passed(self):
        screen = """
        running pytest test/
        test_auth.py .... [ 50%]
        test_api.py ....  [100%]
        ================ 73 passed in 1.42s ================
        > 
        """
        res = foreman.classify_screen_heuristics(screen)
        self.assertEqual(res["choice"], "tests_passed_ready")

    def test_classify_provider_error_529(self):
        screen = """
        API Error: 529 Overloaded. {"error": {"type": "overloaded_error", "message": "Overloaded"}}
        Please try again in a few seconds.
        """
        res = foreman.classify_screen_heuristics(screen)
        self.assertEqual(res["choice"], "provider_error")

    def test_classify_stuck_confirmation(self):
        screen = """
        I have prepared the migration script.
        Do you want me to proceed with applying this change to production?
        """
        res = foreman.classify_screen_heuristics(screen)
        self.assertEqual(res["choice"], "stuck_loop")

    def test_classify_idle_done(self):
        screen = """
        Compilation finished successfully.
        $ 
        """
        res = foreman.classify_screen_heuristics(screen)
        self.assertEqual(res["choice"], "idle_done")

    def test_classify_active_coding(self):
        screen = """
        Building target [=================>          ] 65% (42/64 modules)
        Compiling src/core/engine.cpp
        """
        res = foreman.classify_screen_heuristics(screen)
        self.assertEqual(res["choice"], "active_coding")

    def test_supervise_worker_dry_run(self):
        mock_item = {
            "task": {
                "id": "task_mock_1",
                "status": "in_progress",
                "task_title": "Mock Verification Task",
                "spec": "Run unit tests and verify output"
            },
            "terminal_handle": "term_mock_1",
            "dispatch_id": "ctx_mock_1"
        }
        # Mock read_worker_screen
        original_read = foreman.read_worker_screen
        try:
            foreman.read_worker_screen = lambda h: "================ 976 passed in 62.41s ================\n> "
            result = foreman.supervise_worker("run_test", mock_item, dry_run=True)
            self.assertEqual(result["verdict"], "tests_passed_ready")
            self.assertEqual(result["action"], "emit_worker_done_and_retain")
        finally:
            foreman.read_worker_screen = original_read


if __name__ == "__main__":
    unittest.main()

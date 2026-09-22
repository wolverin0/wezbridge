#!/usr/bin/env python3
import unittest
import tempfile
import subprocess
from pathlib import Path
import sys

# Add scripts directory
sys.path.insert(0, str(Path(__file__).parent.parent / "scripts" / "git"))
from checkpoint_audit import run_incremental_audit, DANGEROUS_PATTERNS


class TestCheckpointAudit(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.repo_dir = Path(self.temp_dir.name)
        subprocess.run(["git", "init"], cwd=self.repo_dir, check=True, capture_output=True)
        subprocess.run(["git", "config", "user.name", "Tester"], cwd=self.repo_dir, check=True)
        subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=self.repo_dir, check=True)

        # Initial commit
        (self.repo_dir / "README.md").write_text("# Hello World\n", encoding="utf-8")
        subprocess.run(["git", "add", "README.md"], cwd=self.repo_dir, check=True)
        subprocess.run(["git", "commit", "-m", "initial commit"], cwd=self.repo_dir, check=True)

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_clean_state_on_no_changes(self):
        res = run_incremental_audit(self.repo_dir, reset=True)
        self.assertEqual(res["status"], "reset")

        # Second run should report clean with 0 modified files
        res2 = run_incremental_audit(self.repo_dir)
        self.assertEqual(res2["status"], "clean")
        self.assertEqual(res2["commits_checked"], 0)

    def test_detects_dangerous_pattern_in_new_commit(self):
        run_incremental_audit(self.repo_dir, reset=True)

        # Introduce bad code
        (self.repo_dir / "bad.sql").write_text("DROP TABLE users;\n", encoding="utf-8")
        subprocess.run(["git", "add", "bad.sql"], cwd=self.repo_dir, check=True)
        subprocess.run(["git", "commit", "-m", "bad sql commit"], cwd=self.repo_dir, check=True)

        res = run_incremental_audit(self.repo_dir)
        self.assertEqual(res["status"], "failed")
        self.assertTrue(any("DROP TABLE" in v["reason"] for v in res["violations"]))

    def test_detects_frontend_changes(self):
        run_incremental_audit(self.repo_dir, reset=True)

        (self.repo_dir / "Button.tsx").write_text("export const Button = () => <button>Click</button>;\n", encoding="utf-8")
        subprocess.run(["git", "add", "Button.tsx"], cwd=self.repo_dir, check=True)
        subprocess.run(["git", "commit", "-m", "add button"], cwd=self.repo_dir, check=True)

        res = run_incremental_audit(self.repo_dir)
        self.assertEqual(res["status"], "passed")
        self.assertTrue(res["frontend_changed"])


if __name__ == "__main__":
    unittest.main()

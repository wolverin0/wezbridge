#!/usr/bin/env python3
"""
test_codex_worker.py - T-0549: codex_worker.py (model/effort validation, command
construction, closure parsing, missing-closure exit code).

Sin codex real: subprocess.run se parchea. El catalogo de modelos se pasa via
--model-tiers a un fixture local para no depender de _intel/model-tiers.json.

Correr:  python scripts/orchestration/test_codex_worker.py -v
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
import codex_worker  # noqa: E402


FIXTURE_CATALOG = {
    "version": 1,
    "models": {
        "claude-sonnet-5": {"runtime": "claude", "efforts": ["low", "medium", "high"]},
        "gpt-6-astra": {"runtime": "codex", "efforts": ["low", "medium", "high", "xhigh", "max", "ultra"]},
        "gpt-6-sol":   {"runtime": "codex", "efforts": ["low", "medium", "high", "xhigh", "max", "ultra"]},
        "gpt-6-luna":  {"runtime": "codex", "efforts": ["low", "medium", "high", "xhigh", "max"]},
    },
}


class CatalogTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="codex-worker-t0549-")
        self.catalog_path = os.path.join(self.tmp, "model-tiers.json")
        with open(self.catalog_path, "w", encoding="utf-8") as f:
            json.dump(FIXTURE_CATALOG, f)
        self.catalog, self.source = codex_worker.load_codex_model_catalog(self.catalog_path)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_loads_only_codex_runtime_entries(self):
        self.assertIn("gpt-6-luna", self.catalog)
        self.assertIn("gpt-6-sol", self.catalog)
        self.assertIn("gpt-6-astra", self.catalog)
        self.assertNotIn("claude-sonnet-5", self.catalog)  # not codex runtime
        self.assertEqual(self.source, self.catalog_path)

    def test_missing_file_falls_back(self):
        catalog, source = codex_worker.load_codex_model_catalog(os.path.join(self.tmp, "nope.json"))
        self.assertEqual(source, "<fallback>")
        self.assertIn("gpt-6-luna", catalog)

    def test_terra_is_unknown(self):
        # GPT-6 has no Terra tier (retired as GPT-5.6) — must not validate.
        with self.assertRaises(ValueError):
            codex_worker.validate_model_effort("gpt-6-terra", "low", self.catalog)

    def test_minimal_effort_invalid_for_gpt6(self):
        for model in ("gpt-6-luna", "gpt-6-sol", "gpt-6-astra"):
            with self.assertRaises(ValueError):
                codex_worker.validate_model_effort(model, "minimal", self.catalog)

    def test_ultra_allowed_only_for_sol_and_astra(self):
        codex_worker.validate_model_effort("gpt-6-sol", "ultra", self.catalog)     # no raise
        codex_worker.validate_model_effort("gpt-6-astra", "ultra", self.catalog)   # no raise
        with self.assertRaises(ValueError):
            codex_worker.validate_model_effort("gpt-6-luna", "ultra", self.catalog)

    def test_valid_pairs_pass(self):
        codex_worker.validate_model_effort("gpt-6-luna", "low", self.catalog)
        codex_worker.validate_model_effort("gpt-6-sol", "high", self.catalog)
        codex_worker.validate_model_effort("gpt-6-astra", "xhigh", self.catalog)


class CommandConstructionTests(unittest.TestCase):
    def test_run_codex_exec_builds_expected_argv(self):
        captured = {}

        def fake_run(cmd, capture_output, text, encoding, errors, timeout, stdin=None):
            captured["cmd"] = cmd
            captured["timeout"] = timeout
            return subprocess.CompletedProcess(cmd, 0, stdout="{}\n", stderr="")

        with mock.patch.object(subprocess, "run", side_effect=fake_run), \
             mock.patch.object(shutil, "which", return_value=None):
            rc, stdout, stderr, cmd, timed_out = codex_worker.run_codex_exec(
                "gpt-6-luna", "low", "/some/cwd", "do the thing",
                180, "/tmp/last-message.txt", codex_bin="codex",
            )

        self.assertEqual(rc, 0)
        self.assertFalse(timed_out)
        self.assertEqual(cmd, [
            "codex", "exec",
            "-m", "gpt-6-luna",
            "-c", "model_reasoning_effort=low",
            "-s", "workspace-write",
            "--cd", "/some/cwd",
            "--skip-git-repo-check",
            "--json",
            "-o", "/tmp/last-message.txt",
            "do the thing",
        ])
        self.assertEqual(captured["timeout"], 180)

    def test_timeout_is_reported_not_raised(self):
        def fake_run(cmd, capture_output, text, encoding, errors, timeout, stdin=None):
            raise subprocess.TimeoutExpired(cmd=cmd, timeout=timeout, output="partial", stderr="")

        with mock.patch.object(subprocess, "run", side_effect=fake_run):
            rc, stdout, stderr, cmd, timed_out = codex_worker.run_codex_exec(
                "gpt-6-luna", "low", "/some/cwd", "do the thing",
                5, "/tmp/last-message.txt",
            )
        self.assertIsNone(rc)
        self.assertTrue(timed_out)


class ClosureParsingTests(unittest.TestCase):
    def test_parses_worker_done_line(self):
        text = (
            "some preamble\n"
            "[WORKER_DONE] task_id=T-0549 outcome=succeeded report=all good\n"
        )
        hit = codex_worker.parse_closure(text, "T-0549")
        self.assertIsNotNone(hit)
        task_id, outcome, extra = hit
        self.assertEqual(task_id, "T-0549")
        self.assertEqual(outcome, "succeeded")
        self.assertIn("all good", extra)

    def test_ignores_echoed_instructions(self):
        # The mission prompt itself contains the literal closure template; the echo of
        # that template (not a real closure) must not be mistaken for one.
        text = "[WORKER_DONE] task_id=T-0549 outcome=succeeded|failed report=<path_or_summary>"
        hit = codex_worker.parse_closure(text, "T-0549")
        self.assertIsNone(hit)

    def test_no_closure_returns_none(self):
        hit = codex_worker.parse_closure("nothing here", "T-0549")
        self.assertIsNone(hit)


class ExtractTurnContextTests(unittest.TestCase):
    def test_extracts_model_from_jsonl_stream(self):
        stdout = "\n".join([
            'not json',
            json.dumps({"type": "session_configured", "model": "gpt-6-luna", "reasoning_effort": "low"}),
            json.dumps({"type": "agent_message", "text": "hi"}),
        ])
        ctx = codex_worker.extract_turn_context(stdout)
        self.assertIsNotNone(ctx)
        self.assertEqual(ctx.get("model"), "gpt-6-luna")

    def test_returns_none_when_absent(self):
        stdout = json.dumps({"type": "agent_message", "text": "hi"})
        self.assertIsNone(codex_worker.extract_turn_context(stdout))


class MainIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="codex-worker-main-t0549-")
        self.foreman_dir = os.path.join(self.tmp, "foreman")
        self.brief_path = os.path.join(self.tmp, "brief.md")
        with open(self.brief_path, "w", encoding="utf-8") as f:
            f.write("Print the first line of README.md and exit.")
        self.catalog_path = os.path.join(self.tmp, "model-tiers.json")
        with open(self.catalog_path, "w", encoding="utf-8") as f:
            json.dump(FIXTURE_CATALOG, f)
        self.patches = [mock.patch.object(codex_worker, "FOREMAN_LOG_DIR", self.foreman_dir)]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _argv(self, model="gpt-6-luna", effort="low"):
        return [
            "--task", "T-0549", "--brief", self.brief_path,
            "--model", model, "--effort", effort, "--cwd", self.tmp,
            "--model-tiers", self.catalog_path, "--timeout", "60",
        ]

    def test_invalid_model_exits_nonzero_without_spawning(self):
        with mock.patch.object(subprocess, "run") as run_mock:
            rc = codex_worker.main(self._argv(model="gpt-6-terra"))
        self.assertNotEqual(rc, 0)
        run_mock.assert_not_called()

    def test_missing_brief_exits_nonzero(self):
        argv = self._argv()
        argv[argv.index("--brief") + 1] = os.path.join(self.tmp, "nope.md")
        with mock.patch.object(subprocess, "run") as run_mock:
            rc = codex_worker.main(argv)
        self.assertNotEqual(rc, 0)
        run_mock.assert_not_called()

    def test_successful_closure_exits_zero(self):
        def fake_run(cmd, capture_output, text, encoding, errors, timeout, stdin=None):
            # -o path is the element right after "-o"
            out_path = cmd[cmd.index("-o") + 1]
            with open(out_path, "w", encoding="utf-8") as f:
                f.write("[WORKER_DONE] task_id=T-0549 outcome=succeeded report=done\n"
                        "criteria:\n- trivial: pass - printed line\n"
                        "files_changed: none\nnext_action: none\n"
                        "model_effort_used: gpt-6-luna low\n")
            return subprocess.CompletedProcess(cmd, 0, stdout="{}\n", stderr="")

        with mock.patch.object(subprocess, "run", side_effect=fake_run):
            rc = codex_worker.main(self._argv())
        self.assertEqual(rc, 0)

    def test_missing_closure_exits_nonzero(self):
        def fake_run(cmd, capture_output, text, encoding, errors, timeout, stdin=None):
            out_path = cmd[cmd.index("-o") + 1]
            with open(out_path, "w", encoding="utf-8") as f:
                f.write("I did some stuff but forgot to close out.\n")
            return subprocess.CompletedProcess(cmd, 0, stdout="{}\n", stderr="")

        with mock.patch.object(subprocess, "run", side_effect=fake_run):
            rc = codex_worker.main(self._argv())
        self.assertEqual(rc, 4)

    def test_failed_closure_exits_nonzero(self):
        def fake_run(cmd, capture_output, text, encoding, errors, timeout, stdin=None):
            out_path = cmd[cmd.index("-o") + 1]
            with open(out_path, "w", encoding="utf-8") as f:
                f.write("[WORKER_DONE] task_id=T-0549 outcome=failed report=blocked\n")
            return subprocess.CompletedProcess(cmd, 0, stdout="{}\n", stderr="")

        with mock.patch.object(subprocess, "run", side_effect=fake_run):
            rc = codex_worker.main(self._argv())
        self.assertEqual(rc, 1)

    def test_timeout_exits_nonzero(self):
        def fake_run(cmd, capture_output, text, encoding, errors, timeout, stdin=None):
            raise subprocess.TimeoutExpired(cmd=cmd, timeout=timeout, output="", stderr="")

        with mock.patch.object(subprocess, "run", side_effect=fake_run):
            rc = codex_worker.main(self._argv())
        self.assertEqual(rc, 3)


if __name__ == "__main__":
    unittest.main()

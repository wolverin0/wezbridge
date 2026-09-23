#!/usr/bin/env python3
"""
test_task_router_from_card.py - T-0548: task_router.py --from-card imprime el comando exacto.

Dos fixtures de tarjeta (runtime claude T2 y runtime codex T1) en un _intel temporal
(WEZBRIDGE_INTEL_DIR) con su propio model-tiers.json. Se corre el CLI real por subprocess
y tambien la funcion pura build_from_card. Nada se lanza: --from-card solo imprime.
Contra el task_router anterior fallan todos: --from-card no existia (argparse sale 2).

Correr:  python scripts/orchestration/test_task_router_from_card.py -v
"""

import json
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROUTER = os.path.join(HERE, "task_router.py")
sys.path.insert(0, HERE)

TIERS = {
    "version": 1,
    "models": {
        "claude-sonnet-5": {"runtime": "claude", "alias": "sonnet", "efforts": ["low", "medium", "high", "xhigh", "max"], "default_effort": "high"},
        "claude-fable-5-1": {"runtime": "claude", "alias": "fable", "efforts": ["low", "medium", "high", "xhigh", "max"], "default_effort": "high"},
        "gpt-6-luna": {"runtime": "codex", "efforts": ["low", "medium", "high", "xhigh", "max"], "default_effort": "medium"},
    },
    "tiers": {
        "T1": {"claude": {"model": "claude-haiku-4-5-20251001", "effort": None}, "codex": {"model": "gpt-6-luna", "effort": "low"}},
        "T2": {"claude": {"model": "claude-sonnet-5", "effort": "medium"}, "codex": {"model": "gpt-6-luna", "effort": "medium"}},
        "T3": {"claude": {"model": "claude-sonnet-5", "effort": "high"}, "codex": None},
        "T5": {"claude": {"model": "claude-fable-5-1", "effort": "xhigh"}, "codex": None},
    },
}

CLAUDE_CARD = {
    "id": "T-0901", "title": "Arreglar parser", "goal": "Que el parser acepte ';' en criterios.",
    "repo": "wezbridge", "state": "ready", "blocked_by": "agent",
    "acceptance_criteria": ["test nuevo verde", "suite verde"],
    "runtime": "claude", "model": "claude-sonnet-5", "effort": "medium", "tier": "T2",
}
CODEX_CARD = {
    "id": "T-0902", "title": "Censo de logs", "goal": "Contar errores 5xx del dia.",
    "repo": "wezbridge", "state": "ready", "blocked_by": "agent",
    "acceptance_criteria": ["conteo con evidencia"],
    "runtime": "codex", "model": "gpt-6-luna", "effort": "low", "tier": "T1",
}
PEDRITO_CARD = {
    "id": "T-0904", "title": "Arreglar factura", "goal": "AFIP receipt fix.",
    "repo": "pedrito", "state": "ready", "blocked_by": "agent",
    "acceptance_criteria": ["test verde"],
    "runtime": "claude", "model": "claude-sonnet-5", "effort": "medium", "tier": "T2",
}


class FromCardTest(unittest.TestCase):
    def setUp(self):
        self.intel = tempfile.mkdtemp(prefix="router-t0548-")
        os.makedirs(os.path.join(self.intel, "tasks"))
        with open(os.path.join(self.intel, "model-tiers.json"), "w", encoding="utf-8") as f:
            json.dump(TIERS, f)
        for c in (CLAUDE_CARD, CODEX_CARD, {**CLAUDE_CARD, "id": "T-0903", "runtime": None, "model": None}, PEDRITO_CARD):
            with open(os.path.join(self.intel, "tasks", f"{c['id']}.json"), "w", encoding="utf-8") as f:
                json.dump(c, f)

    def tearDown(self):
        shutil.rmtree(self.intel, ignore_errors=True)

    def cli(self, *args):
        env = {**os.environ, "WEZBRIDGE_INTEL_DIR": self.intel, "PYTHONIOENCODING": "utf-8"}
        return subprocess.run([sys.executable, ROUTER, *args], capture_output=True, text=True,
                              encoding="utf-8", env=env, timeout=60)

    def test_claude_card_prints_agent_json_and_orca_line(self):
        r = self.cli("--from-card", "T-0901", "--brief", "_intel/briefs/x.md", "--terminal", "term_abc")
        self.assertEqual(r.returncode, 0, r.stderr)
        lines = r.stdout.splitlines()
        call = json.loads(lines[lines.index("# Agent tool call (subagent dispatch):") + 1])
        self.assertEqual(call["subagent_type"], "worker-t2")
        self.assertEqual(call["model"], "sonnet")
        self.assertIn("[MISION T-0901]", call["prompt"])
        self.assertIn("Lee primero el brief: _intel/briefs/x.md", call["prompt"])
        self.assertIn("- test nuevo verde", call["prompt"])
        self.assertIn("model_effort_used: <modelo>/<effort>", call["prompt"])
        self.assertIn("claude-sonnet-5/medium", call["prompt"])
        pane = lines[lines.index("# Pane dispatch (orca):") + 1:]
        argv = shlex.split("\n".join(pane))
        self.assertEqual(argv[:5], ["orca", "terminal", "send", "--terminal", "term_abc"])
        self.assertEqual(argv[5], "--text")
        self.assertEqual(argv[6], call["prompt"], "el orca line lleva el MISMO prompt")
        self.assertEqual(argv[7:], ["--enter"])

    def test_codex_card_prints_codex_exec(self):
        r = self.cli("--from-card", "T-0902", "--worktree", "/w/wezbridge-wt")
        self.assertEqual(r.returncode, 0, r.stderr)
        cmd = r.stdout.split("# Codex worker:\n", 1)[1]
        argv = shlex.split(cmd)
        self.assertEqual(argv[:9], ["codex", "exec", "-m", "gpt-6-luna", "-c", "model_reasoning_effort=low",
                                    "-s", "workspace-write", "--cd"])
        self.assertEqual(argv[9], "/w/wezbridge-wt")
        self.assertEqual(len(argv), 11)
        self.assertIn("[MISION T-0902]", argv[10])
        self.assertIn("- conteo con evidencia", argv[10])

    def test_card_without_model_fails_with_actionable_message(self):
        r = self.cli("--from-card", "T-0903")
        self.assertEqual(r.returncode, 1)
        self.assertIn("--tier", r.stderr)
        r = self.cli("--from-card", "T-9999")
        self.assertEqual(r.returncode, 1)
        self.assertIn("no card", r.stderr)

    def test_pure_builder_fallback_and_default_worktree(self):
        import task_router
        d = task_router.build_from_card({**CLAUDE_CARD, "model": "claude-fable-5-1", "effort": "xhigh", "tier": "T5"}, TIERS)
        self.assertEqual(d["agent_call"]["subagent_type"], "general-purpose")
        self.assertEqual(d["agent_call"]["model"], "fable")
        self.assertTrue(d["notes"], "el fallback se declara, no es silencioso")
        d = task_router.build_from_card({**CLAUDE_CARD, "tier": None}, TIERS)
        self.assertEqual(d["agent_call"]["subagent_type"], "worker-t2", "sin tier se matchea model+effort")
        d = task_router.build_from_card(CODEX_CARD, TIERS)
        self.assertEqual(d["codex_argv"][8], "--cd")
        self.assertTrue(d["codex_argv"][9].endswith("/wezbridge"), d["codex_argv"][9])

    def test_legacy_keyword_path_still_requires_title_prompt(self):
        r = self.cli("--title", "x")
        self.assertEqual(r.returncode, 2)
        self.assertIn("--from-card", r.stderr)

    def test_no_terminal_uses_roster_handle_for_repo(self):
        # T-0554: _intel/orchestrators.json roster with a lane owning CLAUDE_CARD's repo.
        with open(os.path.join(self.intel, "orchestrators.json"), "w", encoding="utf-8") as f:
            json.dump({"lanes": [{"lane": "wezbridge", "repos": ["wezbridge"], "handle": "term_roster_wb"}]}, f)
        r = self.cli("--from-card", "T-0901")
        self.assertEqual(r.returncode, 0, r.stderr)
        argv = shlex.split(r.stdout.split("# Pane dispatch (orca):\n", 1)[1])
        self.assertIn("term_roster_wb", argv)

    def test_missing_roster_falls_back_to_legacy_registry(self):
        # No orchestrators.json written: PEDRITO_CARD's repo matches WORKER_REGISTRY["pedrito"].
        r = self.cli("--from-card", "T-0904")
        self.assertEqual(r.returncode, 0, r.stderr)
        argv = shlex.split(r.stdout.split("# Pane dispatch (orca):\n", 1)[1])
        self.assertIn("term_5bc6d4ef-16e4-40e0-bd5d-765cb075e781", argv)

    def test_lane_matches_with_null_handle_uses_placeholder_not_legacy(self):
        # T-0554: roster is authoritative once a lane owns the repo -- a null handle must NOT
        # fall through to the dead legacy term_5bc6d4ef... handle for pedrito.
        with open(os.path.join(self.intel, "orchestrators.json"), "w", encoding="utf-8") as f:
            json.dump({"lanes": [{"lane": "pedrito", "repos": ["pedrito"], "handle": None}]}, f)
        r = self.cli("--from-card", "T-0904")
        self.assertEqual(r.returncode, 0, r.stderr)
        argv = shlex.split(r.stdout.split("# Pane dispatch (orca):\n", 1)[1])
        self.assertIn("<TERMINAL_ID>", argv)
        self.assertNotIn("term_5bc6d4ef-16e4-40e0-bd5d-765cb075e781", argv)
        self.assertIn("no live handle", r.stderr)

    def test_malformed_roster_falls_back_to_legacy_registry(self):
        with open(os.path.join(self.intel, "orchestrators.json"), "w", encoding="utf-8") as f:
            f.write("{not valid json")
        r = self.cli("--from-card", "T-0904")
        self.assertEqual(r.returncode, 0, r.stderr)
        argv = shlex.split(r.stdout.split("# Pane dispatch (orca):\n", 1)[1])
        self.assertIn("term_5bc6d4ef-16e4-40e0-bd5d-765cb075e781", argv)


if __name__ == "__main__":
    unittest.main()

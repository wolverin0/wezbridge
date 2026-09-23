#!/usr/bin/env python3
"""
test_foreman_model_effort.py - T-0548: al cerrar, Foreman registra model_effort_used.

El worker declara `model_effort_used: <modelo>/<effort>` en su bloque criteria. Foreman lo
toma del screen (ultima ocurrencia real; el eco de la plantilla del despacho lleva '<' y se
ignora), lo guarda en su estado y lo SUMA a la evidencia de la tarjeta con
`ledger.cjs update T --evidence-append`. El ledger corre de verdad contra un _intel temporal
(WEZBRIDGE_INTEL_DIR); el notificador y la terminal se parchean.

Correr:  python scripts/orchestration/test_foreman_model_effort.py -v
"""

import json
import os
import shutil
import sys
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import foreman  # noqa: E402

SCREEN = "\n".join([
    "[MISION T-0911] algo",
    "y la linea `model_effort_used: <modelo>/<effort>` con lo que realmente corriste (la tarjeta pide claude-sonnet-5/medium).",
    "criteria:",
    "- test verde: pass — 7/0",
    "model_effort_used: claude-sonnet-5/high",
    "[WORKER_DONE] task_id=T-0911 outcome=succeeded report=_intel/briefs/r.md",
])


class ModelEffortTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="foreman-t0548-")
        self.intel = os.path.join(self.tmp, "intel")
        os.makedirs(os.path.join(self.intel, "tasks"))
        with open(os.path.join(self.intel, "tasks", "T-0911.json"), "w", encoding="utf-8") as f:
            json.dump({"id": "T-0911", "title": "x", "goal": "y", "kind": "general", "repo": "wezbridge",
                       "state": "running", "blocked_by": "agent", "acceptance_criteria": ["a"],
                       "lease": None, "attempt": 1, "evaluator_evidence": "suite 10/0"}, f)
        self.patches = [
            mock.patch.object(foreman, "STATE_DIR", os.path.join(self.tmp, "foreman")),
            mock.patch.dict(os.environ, {"WEZBRIDGE_INTEL_DIR": self.intel}),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_parser_ignores_template_echo_and_takes_last_real_value(self):
        self.assertEqual(foreman.find_model_effort_used(SCREEN), "claude-sonnet-5/high")
        self.assertIsNone(foreman.find_model_effort_used(SCREEN.splitlines()[1]), "la plantilla sola no cuenta")
        self.assertIsNone(foreman.find_model_effort_used("nada"))

    def test_closure_writes_state_and_appends_ledger_evidence(self):
        state = {"task_id": "T-0911", "terminal": "term_x"}
        with mock.patch.object(foreman, "read_terminal_screen", return_value=SCREEN), \
                mock.patch.object(foreman.time, "sleep"), \
                mock.patch.object(foreman, "notify_orchestrator"):
            out = foreman.supervise_task("T-0911", "term_x", max_wait_sec=30, state=state)
        self.assertEqual(out["status"], "completed")
        with open(foreman.state_path("T-0911"), encoding="utf-8") as f:
            saved = json.load(f)
        self.assertEqual(saved["model_effort_used"], "claude-sonnet-5/high")
        self.assertTrue(saved.get("model_effort_recorded"))
        with open(os.path.join(self.intel, "tasks", "T-0911.json"), encoding="utf-8") as f:
            ev = json.load(f)["evaluator_evidence"]
        self.assertTrue(ev.startswith("suite 10/0\nmodel_effort_used: claude-sonnet-5/high"),
                        f"append, no reemplazo: {ev!r}")

    def test_closure_without_declaration_leaves_card_untouched(self):
        screen = "[WORKER_DONE] task_id=T-0911 outcome=succeeded report=r.md"
        with mock.patch.object(foreman, "read_terminal_screen", return_value=screen), \
                mock.patch.object(foreman.time, "sleep"), \
                mock.patch.object(foreman, "notify_orchestrator"):
            foreman.supervise_task("T-0911", "term_x", max_wait_sec=30, state={"task_id": "T-0911"})
        with open(os.path.join(self.intel, "tasks", "T-0911.json"), encoding="utf-8") as f:
            self.assertEqual(json.load(f)["evaluator_evidence"], "suite 10/0")


if __name__ == "__main__":
    unittest.main()

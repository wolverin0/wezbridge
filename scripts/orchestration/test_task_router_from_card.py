#!/usr/bin/env python3
"""
test_task_router_from_card.py - T-0548/T-0596 paso 2: task_router.py --from-card imprime
el comando exacto.

Dos fixtures de tarjeta (runtime claude T2 y runtime codex T1) en un _intel temporal
(WEZBRIDGE_INTEL_DIR) con su propio model-tiers.json. Se corre el CLI real por subprocess
y tambien la funcion pura build_from_card. Nada se lanza: --from-card solo imprime.

T-0596 paso 2: la linea de "Pane dispatch" ya NO es un `orca terminal send` con un handle
resuelto por task_router (roster u WORKER_REGISTRY) — es un `node bin/a2a-send-cli.cjs
--to-project <repo>`. La resolucion del handle vivo (WezTerm o Orca) queda enteramente del
lado de a2a-send-cli.cjs, en tiempo de envio; task_router.py ya no sabe ni le importa que
handle existe.

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

    def test_claude_card_prints_agent_json_and_a2a_send_cli_line(self):
        r = self.cli("--from-card", "T-0901", "--brief", "_intel/briefs/x.md")
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
        pane = lines[lines.index("# Pane dispatch (a2a-send-cli):") + 1:]
        argv = shlex.split("\n".join(pane))
        # argv shape: [node, <...>/bin/a2a-send-cli.cjs, --to-project, wezbridge, --type, request, --corr, T-0901, --body, <prompt>]
        self.assertTrue(argv[1].endswith(os.path.join("bin", "a2a-send-cli.cjs")), argv[1])
        self.assertEqual(argv[2:6], ["--to-project", "wezbridge", "--type", "request"])
        self.assertEqual(argv[6:8], ["--corr", "T-0901"])
        self.assertEqual(argv[8], "--body")
        self.assertEqual(argv[9], call["prompt"], "el a2a-send-cli line lleva el MISMO prompt")
        self.assertNotIn("--terminal", argv, "T-0596 paso 2: nunca un handle fijo")

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

    def test_repo_is_the_target_project_whatever_orchestrators_json_says(self):
        # T-0596 paso 2: task_router.py no lee mas _intel/orchestrators.json (ni ningun
        # censo) para resolver un handle -- eso vive enteramente en a2a-send-cli.cjs, en
        # tiempo de envio. Un roster presente o ausente no debe cambiar nada aca.
        with open(os.path.join(self.intel, "orchestrators.json"), "w", encoding="utf-8") as f:
            json.dump({"lanes": [{"lane": "wezbridge", "repos": ["wezbridge"], "handle": "term_roster_wb"}]}, f)
        r = self.cli("--from-card", "T-0901")
        self.assertEqual(r.returncode, 0, r.stderr)
        argv = shlex.split(r.stdout.split("# Pane dispatch (a2a-send-cli):\n", 1)[1])
        self.assertIn("--to-project", argv)
        self.assertEqual(argv[argv.index("--to-project") + 1], "wezbridge")
        self.assertNotIn("term_roster_wb", argv, "ningun handle se hornea en el comando impreso")

    def test_no_orchestrators_json_still_prints_to_project(self):
        # Sin _intel/orchestrators.json: antes esto caia al WORKER_REGISTRY legacy
        # (default_term_id); ahora simplemente no hay resolucion que hacer aca.
        r = self.cli("--from-card", "T-0904")
        self.assertEqual(r.returncode, 0, r.stderr)
        argv = shlex.split(r.stdout.split("# Pane dispatch (a2a-send-cli):\n", 1)[1])
        self.assertEqual(argv[argv.index("--to-project") + 1], "pedrito")
        self.assertNotIn("term_5bc6d4ef-16e4-40e0-bd5d-765cb075e781", argv, "sin handles hardcodeados")

    def test_no_hardcoded_term_ids_survive_in_the_registry(self):
        import task_router
        for cfg in task_router.WORKER_REGISTRY.values():
            self.assertNotIn("default_term_id", cfg)


if __name__ == "__main__":
    unittest.main()

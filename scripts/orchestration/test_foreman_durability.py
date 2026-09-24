#!/usr/bin/env python3
"""
test_foreman_durability.py - T-0524: Foreman durable (estado, reanudacion, watcher, outbox).

Sin orca real: se parchean read_terminal_screen, subprocess.run y el notificador. El ultimo
caso (E2EKillTest) lanza procesos python reales, mata al Foreman a mitad y verifica que el
watcher lo relanza y deja el aviso [FOREMAN_RESUMED] (en el outbox, porque ORCA_BIN apunta a
un binario inexistente: ningun mensaje de prueba llega a una terminal real).

Correr:  python scripts/orchestration/test_foreman_durability.py -v
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import foreman  # noqa: E402
import foreman_watch  # noqa: E402
import notify_orchestrator  # noqa: E402


class TmpDirs(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="foreman-t0524-")
        self.state_dir = os.path.join(self.tmp, "foreman")
        self.tasks_dir = os.path.join(self.tmp, "tasks")
        os.makedirs(self.tasks_dir)
        self.patches = [
            mock.patch.object(foreman, "STATE_DIR", self.state_dir),
            mock.patch.object(notify_orchestrator, "STATE_DIR", self.state_dir),
            mock.patch.object(foreman_watch, "TASKS_DIR", self.tasks_dir),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def write_card(self, task_id, state):
        with open(os.path.join(self.tasks_dir, f"{task_id}.json"), "w", encoding="utf-8") as f:
            json.dump({"id": task_id, "state": state}, f)

    def write_state(self, **fields):
        os.makedirs(self.state_dir, exist_ok=True)
        st = {"task_id": "T-9001", "terminal": "term_x", "timeout_sec": 600,
              "deadline_epoch": time.time() + 600, "deadline": "2099-01-01T00:00:00Z",
              "status": "supervising", "pid": 999999, "resume_count": 0}
        st.update(fields)
        with open(foreman.state_path(st["task_id"]), "w", encoding="utf-8") as f:
            json.dump(st, f)
        return st


class StatePersistenceTest(TmpDirs):
    def test_state_written_on_start_updated_per_poll_and_finalized(self):
        screens = iter(["compilando...", "sigue",
                        "[WORKER_DONE] task_id=T-9001 outcome=succeeded report=r.md"])
        snapshots = []
        real_save = foreman.save_state

        def spy_save(state):
            snapshots.append(json.loads(json.dumps(state)))
            return real_save(state)

        with mock.patch.object(foreman, "read_terminal_screen", side_effect=lambda t: next(screens)), \
                mock.patch.object(foreman.time, "sleep"), \
                mock.patch.object(foreman, "notify_orchestrator") as notify, \
                mock.patch.object(foreman, "save_state", side_effect=spy_save):
            foreman.main(["--task-id", "T-9001", "--terminal", "term_x", "--timeout", "600"])

        first = snapshots[0]
        self.assertEqual(first["status"], "supervising")
        self.assertEqual(first["pid"], os.getpid())
        self.assertEqual(first["terminal"], "term_x")
        self.assertAlmostEqual(first["deadline_epoch"], time.time() + 600, delta=5)
        self.assertIsNone(first["last_poll"])
        polls = [s for s in snapshots if s.get("last_poll")]
        self.assertGreaterEqual(len(polls), 3, "cada poll debe persistir last_poll")
        self.assertNotEqual(polls[0]["last_screen_sha1"], polls[1]["last_screen_sha1"])
        final = foreman.load_state("T-9001")
        self.assertEqual(final["status"], "done")
        self.assertEqual(final["outcome"], "succeeded")
        self.assertEqual(final["report"], "report=r.md")
        notify.assert_called_once()
        self.assertIn("[WORKER_DONE] task_id=T-9001 outcome=succeeded", notify.call_args[0][0])

    def test_timeout_sets_final_status(self):
        with mock.patch.object(foreman, "read_terminal_screen", return_value="nada"), \
                mock.patch.object(foreman.time, "sleep"), \
                mock.patch.object(foreman, "notify_orchestrator") as notify:
            foreman.main(["--task-id", "T-9001", "--terminal", "term_x", "--timeout", "0"])
        self.assertEqual(foreman.load_state("T-9001")["status"], "timeout")
        self.assertIn("[FOREMAN_TIMEOUT]", notify.call_args[0][0])


class ResumeTest(TmpDirs):
    def _run_capturing_deadline(self, argv):
        with mock.patch.object(foreman, "supervise_task") as sup:
            foreman.main(argv)
        return sup.call_args

    def test_resume_keeps_original_deadline_and_terminal(self):
        original = time.time() + 123
        self.write_state(deadline_epoch=original, terminal="term_orig", status="orphaned")
        call = self._run_capturing_deadline(["--resume", "T-9001"])
        self.assertEqual(call.args[1], "term_orig")
        self.assertEqual(call.kwargs["deadline"], original)
        st = foreman.load_state("T-9001")
        self.assertEqual(st["status"], "supervising")
        self.assertEqual(st["pid"], os.getpid())
        self.assertEqual(st["deadline_epoch"], original)

    def test_auto_resume_when_state_exists_does_not_restart_timeout(self):
        original = time.time() + 50
        self.write_state(deadline_epoch=original)
        call = self._run_capturing_deadline(
            ["--task-id", "T-9001", "--terminal", "term_x", "--timeout", "14400"])
        self.assertEqual(call.kwargs["deadline"], original)

    def test_fresh_restarts_timeout(self):
        self.write_state(deadline_epoch=time.time() + 50)
        call = self._run_capturing_deadline(
            ["--task-id", "T-9001", "--terminal", "term_x", "--timeout", "14400", "--fresh"])
        self.assertAlmostEqual(call.kwargs["deadline"], time.time() + 14400, delta=5)

    def test_finished_state_is_not_resumed(self):
        self.write_state(status="done", deadline_epoch=time.time() + 50)
        call = self._run_capturing_deadline(
            ["--task-id", "T-9001", "--terminal", "term_x", "--timeout", "1000"])
        self.assertAlmostEqual(call.kwargs["deadline"], time.time() + 1000, delta=5)

    def test_resume_past_deadline_does_final_check_then_timeout(self):
        self.write_state(deadline_epoch=time.time() - 10)
        with mock.patch.object(foreman, "read_terminal_screen", return_value="") as rd, \
                mock.patch.object(foreman, "notify_orchestrator"):
            foreman.main(["--resume", "T-9001"])
        rd.assert_called_once()
        self.assertEqual(foreman.load_state("T-9001")["status"], "timeout")

    def test_resume_without_state_errors(self):
        with self.assertRaises(SystemExit):
            foreman.main(["--resume", "T-NOPE"])


class WatcherTest(TmpDirs):
    def test_pid_alive_is_real_and_non_destructive(self):
        self.assertTrue(foreman_watch.pid_alive(os.getpid()))
        p = subprocess.Popen([sys.executable, "-c", "pass"])
        p.wait()
        self.assertFalse(foreman_watch.pid_alive(p.pid))
        self.assertFalse(foreman_watch.pid_alive(None))
        self.assertTrue(foreman_watch.pid_alive(os.getpid()), "el chequeo no debe matar el proceso")

    def test_relaunches_when_pid_dead_and_card_running(self):
        self.write_state(pid=999999)
        self.write_card("T-9001", "running")
        fake = mock.Mock(pid=4242)
        with mock.patch.object(foreman_watch, "pid_alive", return_value=False), \
                mock.patch.object(foreman_watch, "launch_resume", return_value=fake) as launch, \
                mock.patch.object(notify_orchestrator, "notify") as notify, \
                mock.patch.object(notify_orchestrator, "drain_outbox"):
            summary = foreman_watch.run_once()
        self.assertEqual(summary, {"T-9001": "resumed"})
        launch.assert_called_once_with("T-9001")
        st = foreman.load_state("T-9001")
        self.assertEqual(st["status"], "orphaned")
        self.assertEqual(st["resume_count"], 1)
        self.assertEqual(st["dead_pid"], 999999)
        self.assertIn("orphaned_at", st)
        self.assertTrue(notify.call_args[0][0].startswith("[FOREMAN_RESUMED] task_id=T-9001"))

    def test_closes_when_card_not_running(self):
        self.write_state(pid=999999)
        self.write_card("T-9001", "done")
        with mock.patch.object(foreman_watch, "pid_alive", return_value=False), \
                mock.patch.object(foreman_watch, "launch_resume") as launch, \
                mock.patch.object(notify_orchestrator, "notify") as notify, \
                mock.patch.object(notify_orchestrator, "drain_outbox"):
            summary = foreman_watch.run_once()
        self.assertEqual(summary, {"T-9001": "closed"})
        launch.assert_not_called()
        notify.assert_not_called()
        st = foreman.load_state("T-9001")
        self.assertEqual(st["status"], "closed")
        self.assertIn("state=done", st["closed_reason"])

    def test_alive_foreman_is_left_alone(self):
        self.write_state(pid=os.getpid())
        self.write_card("T-9001", "done")
        with mock.patch.object(foreman_watch, "launch_resume") as launch, \
                mock.patch.object(notify_orchestrator, "drain_outbox"):
            summary = foreman_watch.run_once()
        self.assertEqual(summary, {"T-9001": "alive"})
        launch.assert_not_called()
        self.assertEqual(foreman.load_state("T-9001")["status"], "supervising")

    def test_relaunch_cap_alerts_once(self):
        self.write_state(pid=999999, resume_count=foreman_watch.MAX_RESUMES)
        self.write_card("T-9001", "running")
        with mock.patch.object(foreman_watch, "pid_alive", return_value=False), \
                mock.patch.object(foreman_watch, "launch_resume") as launch, \
                mock.patch.object(notify_orchestrator, "notify") as notify, \
                mock.patch.object(notify_orchestrator, "drain_outbox"):
            foreman_watch.run_once()
            foreman_watch.run_once()
        launch.assert_not_called()
        self.assertEqual(notify.call_count, 1)
        self.assertTrue(notify.call_args[0][0].startswith("[FOREMAN_ORPHANED] task_id=T-9001"))


class FakeRun:
    """Sustituto de subprocess.run: T-0596 paso 2 — deliver() ahora llama
    bin/a2a-send-cli.cjs (via `node`) en vez de `orca terminal send` a mano;
    send_ntfy() sigue llamando `node src/ntfy-notifier.cjs`. Ambos tienen
    cmd[0] == "node", asi que se distinguen por cmd[1] (la ruta del script)."""
    def __init__(self, deliver_ok=False, ntfy_ok=True):
        self.deliver_ok, self.ntfy_ok, self.calls = deliver_ok, ntfy_ok, []

    def __call__(self, cmd, **kw):
        self.calls.append(cmd)
        if len(cmd) > 1 and cmd[1] == notify_orchestrator.NTFY_NOTIFIER:
            return subprocess.CompletedProcess(cmd, 0 if self.ntfy_ok else 1, "ok\n", "")
        if len(cmd) > 1 and cmd[1] == notify_orchestrator.A2A_SEND_CLI:
            if not self.deliver_ok:
                return subprocess.CompletedProcess(cmd, 1, "", "a2a-send-cli: mock failure")
            return subprocess.CompletedProcess(cmd, 0, json.dumps({"ok": True, "queued": True}), "")
        raise FileNotFoundError(f"FakeRun: unexpected cmd {cmd}")

    def ntfy_calls(self):
        return [c for c in self.calls if len(c) > 1 and c[1] == notify_orchestrator.NTFY_NOTIFIER]

    def deliver_calls(self):
        return [c for c in self.calls if len(c) > 1 and c[1] == notify_orchestrator.A2A_SEND_CLI]


class OutboxTest(TmpDirs):
    def test_failed_notify_is_queued_and_returns_false(self):
        with mock.patch.object(notify_orchestrator.subprocess, "run", FakeRun(deliver_ok=False)):
            ok = notify_orchestrator.notify("[WORKER_DONE] task_id=T-9001 outcome=succeeded")
        self.assertFalse(ok)
        box = notify_orchestrator.read_outbox()
        self.assertEqual(len(box), 1)
        self.assertEqual(box[0]["message"], "[WORKER_DONE] task_id=T-9001 outcome=succeeded")
        self.assertEqual(box[0]["attempts"], 1)
        self.assertIn("rc=1", box[0]["last_error"])
        self.assertIn("ts", box[0])

    def test_cli_spawn_failure_is_queued(self):
        def run(cmd, **kw):
            raise FileNotFoundError("node no esta en PATH")
        with mock.patch.object(notify_orchestrator.subprocess, "run", run):
            self.assertFalse(notify_orchestrator.notify("hola"))
        self.assertIn("FileNotFoundError", notify_orchestrator.read_outbox()[0]["last_error"])

    def test_retry_ntfy_after_three_attempts_then_drain_on_success(self):
        fail = FakeRun(deliver_ok=False, ntfy_ok=True)
        with mock.patch.object(notify_orchestrator.subprocess, "run", fail):
            notify_orchestrator.notify("msg-1")                       # intento 1 -> encolado
            self.assertEqual(notify_orchestrator.drain_outbox(), (0, 1))  # intento 2
            self.assertEqual(fail.ntfy_calls(), [])
            notify_orchestrator.drain_outbox()                        # intento 3 -> ntfy
            notify_orchestrator.drain_outbox()                        # intento 4 -> ntfy NO se repite
        self.assertEqual(len(fail.ntfy_calls()), 1)
        self.assertIn("msg-1", fail.ntfy_calls()[0])
        entry = notify_orchestrator.read_outbox()[0]
        self.assertEqual(entry["attempts"], 4)
        self.assertTrue(entry["ntfy_sent"])

        ok = FakeRun(deliver_ok=True)
        with mock.patch.object(notify_orchestrator.subprocess, "run", ok):
            self.assertEqual(notify_orchestrator.drain_outbox(), (1, 0))
        self.assertEqual(notify_orchestrator.read_outbox(), [])
        self.assertIn(
            [notify_orchestrator.NODE_BIN, notify_orchestrator.A2A_SEND_CLI, "--to-project",
             notify_orchestrator.ORCHESTRATOR_PROJECT, "--type", "progress", "--body", "msg-1"],
            ok.deliver_calls())
        with open(os.path.join(self.state_dir, "outbox.delivered.jsonl"), encoding="utf-8") as f:
            self.assertEqual(json.loads(f.readline())["message"], "msg-1")

    def test_ntfy_failure_keeps_message(self):
        fail = FakeRun(deliver_ok=False, ntfy_ok=False)
        with mock.patch.object(notify_orchestrator.subprocess, "run", fail):
            notify_orchestrator.notify("msg-2")
            for _ in range(4):
                notify_orchestrator.drain_outbox()
        entry = notify_orchestrator.read_outbox()[0]
        self.assertFalse(entry["ntfy_sent"])
        self.assertIn("ntfy rc=1", entry["ntfy_error"])
        self.assertEqual(len(fail.ntfy_calls()), 3, "ntfy se reintenta mientras no salga")

    def test_success_is_not_queued(self):
        with mock.patch.object(notify_orchestrator.subprocess, "run", FakeRun(deliver_ok=True)):
            self.assertTrue(notify_orchestrator.notify("ok"))
        self.assertEqual(notify_orchestrator.read_outbox(), [])

    def test_no_hardcoded_terminal_handle_in_the_dispatch_command(self):
        """T-0596 paso 2 AC: deliver() addresses the orchestrator by PROJECT, never a
        fixed terminal handle — the resolver (WezTerm or Orca) runs inside a2a-send-cli."""
        ok = FakeRun(deliver_ok=True)
        with mock.patch.object(notify_orchestrator.subprocess, "run", ok):
            notify_orchestrator.notify("ping")
        cmd = ok.deliver_calls()[0]
        self.assertNotIn("--terminal", cmd)
        self.assertIn("--to-project", cmd)
        self.assertNotIn("term_orch", cmd)


class E2EKillTest(TmpDirs):
    """Criterio de la tarjeta: matar el Foreman a mitad y ver el aviso."""

    def _wait_state(self, pred, timeout=20):
        end = time.time() + timeout
        while time.time() < end:
            st = foreman.load_state("T-9001")
            if st and pred(st):
                return st
            time.sleep(0.2)
        self.fail(f"estado no llego a la condicion: {foreman.load_state('T-9001')}")

    def test_kill_foreman_midway_watcher_resumes_and_warns(self):
        self.write_card("T-9001", "running")
        # T-0596 paso 2: deliver() now shells out to A2A_SEND_CLI (node bin/a2a-send-cli.cjs),
        # not `orca` directly — point it at a path that does not exist so this E2E test can
        # NEVER reach a real MCP server / real pane census (the fleet forbids live smoke
        # against a real pane; ORCA_BIN is kept too in case anything still reads it).
        env = dict(os.environ, FOREMAN_STATE_DIR=self.state_dir, FOREMAN_TASKS_DIR=self.tasks_dir,
                   ORCA_BIN=os.path.join(self.tmp, "no-orca.exe"),
                   A2A_SEND_CLI=os.path.join(self.tmp, "no-a2a-send-cli.cjs"))
        first = subprocess.Popen([sys.executable, os.path.join(HERE, "foreman.py"), "--task-id", "T-9001",
                                  "--terminal", "term_fake_t0524", "--timeout", "900"],
                                 env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        relaunched = None
        try:
            st = self._wait_state(lambda s: s.get("pid") == first.pid)
            deadline = st["deadline_epoch"]
            first.kill()
            first.wait()
            out = subprocess.run([sys.executable, os.path.join(HERE, "foreman_watch.py")], env=env,
                                 capture_output=True, text=True, timeout=60)
            self.assertIn("T-9001: resumed", out.stdout, out.stdout + out.stderr)
            st = self._wait_state(lambda s: s.get("status") == "supervising" and s.get("pid") != first.pid)
            relaunched = st["pid"]
            self.assertTrue(foreman_watch.pid_alive(relaunched))
            self.assertEqual(st["deadline_epoch"], deadline, "el relanzado conserva el deadline original")
            self.assertEqual(st["resume_count"], 1)
            box = notify_orchestrator.read_outbox()
            self.assertTrue(any(e["message"].startswith("[FOREMAN_RESUMED] task_id=T-9001") for e in box), box)
            # Segunda pasada: el Foreman relanzado esta vivo -> no se toca.
            out2 = subprocess.run([sys.executable, os.path.join(HERE, "foreman_watch.py")], env=env,
                                  capture_output=True, text=True, timeout=60)
            self.assertIn("T-9001: alive", out2.stdout, out2.stdout + out2.stderr)
        finally:
            if first.poll() is None:
                first.kill()
            if relaunched and foreman_watch.pid_alive(relaunched):
                os.kill(relaunched, 9)  # solo el proceso que lanzo este test
                time.sleep(0.5)


if __name__ == "__main__":
    unittest.main()

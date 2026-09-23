#!/usr/bin/env python3
"""
foreman_watch.py - detector de supervisiones Foreman huerfanas (T-0524).

Corre desde Task Scheduler (WezBridge-ForemanWatch, cada 5 min, via scripts/run-foreman-watch.cmd).
Foreman (foreman.py) es un proceso hijo de la sesion que lo lanza: muere con ella o con el sleep
del PC sin avisar. Este watcher es el unico componente 24/7 del circuito:

  1. Reintenta la cola de notificaciones no entregadas (_intel/foreman/outbox.jsonl).
  2. Para cada _intel/foreman/<task>.json con status supervising|orphaned:
     - pid vivo                       -> nada.
     - tarjeta del ledger != running  -> status=closed (no se relanza nada).
     - pid muerto + tarjeta running   -> relanza `foreman.py --resume <task>` DESACOPLADO
                                         (conserva el deadline original) y avisa
                                         [FOREMAN_RESUMED]. Tope MAX_RESUMES; al superarlo
                                         avisa [FOREMAN_ORPHANED] una sola vez.

Nunca mata procesos. Sin modelo en este camino.
"""

import argparse
import glob
import json
import os
import subprocess
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import foreman  # noqa: E402
import notify_orchestrator  # noqa: E402

TASKS_DIR = os.environ.get("FOREMAN_TASKS_DIR") or os.path.join(foreman._PY_APPS, "_intel", "tasks")
FOREMAN_SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "foreman.py")
MAX_RESUMES = 5
ACTIVE = ("supervising", "orphaned")


def _now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def pid_alive(pid):
    """True si pid es un proceso python vivo. En Windows NO se usa os.kill(pid, 0):
    ahi llama a TerminateProcess y mataria al Foreman que se quiere observar."""
    if not pid:
        return False
    pid = int(pid)
    if sys.platform != "win32":
        try:
            os.kill(pid, 0)
            return True
        except OSError:
            return False
    import ctypes
    from ctypes import wintypes
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.OpenProcess.restype = wintypes.HANDLE
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    h = k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not h:
        return False
    try:
        code = wintypes.DWORD()
        if not k32.GetExitCodeProcess(h, ctypes.byref(code)) or code.value != 259:  # STILL_ACTIVE
            return False
        # Un pid reciclado por otro programa no es nuestro Foreman.
        buf = ctypes.create_unicode_buffer(1024)
        size = wintypes.DWORD(len(buf))
        if k32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
            return "python" in os.path.basename(buf.value).lower()
        return True
    finally:
        k32.CloseHandle(h)


def card_state(task_id):
    try:
        with open(os.path.join(TASKS_DIR, f"{task_id}.json"), "r", encoding="utf-8") as f:
            return json.load(f).get("state")
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as e:
        return f"unreadable:{type(e).__name__}"


def launch_resume(task_id):
    """Relanza Foreman desacoplado de este proceso (sobrevive al fin de la tarea programada)."""
    os.makedirs(foreman.STATE_DIR, exist_ok=True)
    log = open(os.path.join(foreman.STATE_DIR, f"{task_id}.log"), "a", encoding="utf-8")
    log.write(f"\n[{_now_iso()}] foreman_watch relanza --resume {task_id}\n")
    log.flush()
    cmd = [sys.executable, FOREMAN_SCRIPT, "--resume", task_id]
    kwargs = dict(stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, close_fds=True,
                  cwd=os.path.dirname(FOREMAN_SCRIPT))
    if sys.platform == "win32":
        base = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
        try:  # salir del job object de Task Scheduler si lo permite
            return subprocess.Popen(cmd, creationflags=base | subprocess.CREATE_BREAKAWAY_FROM_JOB, **kwargs)
        except OSError:
            return subprocess.Popen(cmd, creationflags=base, **kwargs)
    return subprocess.Popen(cmd, start_new_session=True, **kwargs)


def check_state(state):
    """Evalua un estado activo. Devuelve la accion tomada (str)."""
    task_id = state["task_id"]
    if pid_alive(state.get("pid")):
        return "alive"
    card = card_state(task_id)
    if card != "running":
        state.update({"status": "closed", "closed_at": _now_iso(),
                      "closed_reason": f"foreman pid {state.get('pid')} muerto y tarjeta state={card}"})
        foreman.save_state(state)
        return "closed"
    resumes = int(state.get("resume_count", 0))
    if resumes >= MAX_RESUMES:
        if not state.get("orphan_alerted"):
            state.update({"status": "orphaned", "orphan_alerted": _now_iso()})
            foreman.save_state(state)
            notify_orchestrator.notify(
                f"[FOREMAN_ORPHANED] task_id={task_id} terminal={state.get('terminal')}: Foreman murio "
                f"{resumes + 1} veces; no se relanza mas. Supervisa a mano o relanza con --fresh.")
        return "orphaned"
    state.update({"status": "orphaned", "orphaned_at": _now_iso(), "resume_count": resumes + 1,
                  "dead_pid": state.get("pid")})
    foreman.save_state(state)
    try:
        proc = launch_resume(task_id)
    except Exception as e:
        notify_orchestrator.notify(
            f"[FOREMAN_ORPHANED] task_id={task_id}: Foreman muerto y el relanzamiento fallo: {e}")
        return "relaunch-failed"
    notify_orchestrator.notify(
        f"[FOREMAN_RESUMED] task_id={task_id} terminal={state.get('terminal')} pid={proc.pid} "
        f"(el Foreman anterior pid={state.get('dead_pid')} murio; reanudado con el deadline "
        f"original {state.get('deadline')}, relanzamiento {resumes + 1}/{MAX_RESUMES})")
    return "resumed"


def run_once():
    notify_orchestrator.drain_outbox()
    summary = {}
    for path in sorted(glob.glob(os.path.join(foreman.STATE_DIR, "*.json"))):
        try:
            with open(path, "r", encoding="utf-8") as f:
                state = json.load(f)
        except (OSError, ValueError) as e:
            print(f"[watch] estado ilegible {path}: {e}")
            continue
        if not isinstance(state, dict) or state.get("status") not in ACTIVE or not state.get("task_id"):
            continue
        action = check_state(state)
        summary[state["task_id"]] = action
        print(f"[watch] {state['task_id']}: {action}")
    return summary


def main(argv=None):
    argparse.ArgumentParser(description="Detector de supervisiones Foreman huerfanas").parse_args(argv)
    summary = run_once()
    print(f"[watch] {_now_iso()} activos={len(summary)} {json.dumps(summary)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

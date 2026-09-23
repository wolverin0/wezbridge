#!/usr/bin/env python3
"""
Foreman Supervisor for Orca Workers

Monitors active worker terminals, detects completion sentinels [WORKER_DONE],
auto-nudges stuck workers, and notifies the Orchestrator.
"""

import sys
import os
import json
import subprocess
import time
import re
import argparse
import hashlib
from datetime import datetime, timezone

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8")

ORCHESTRATOR_NOTIFIER = os.path.join(os.path.dirname(__file__), "notify_orchestrator.py")

# Estado durable (T-0524): Foreman es hijo de la sesion que lo lanza y muere con ella o con
# el sleep del PC. El estado en disco permite que foreman_watch.py (Task Scheduler) detecte la
# supervision huerfana y la reanude desde el deadline original, no desde cero.
_PY_APPS = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".."))
STATE_DIR = os.environ.get("FOREMAN_STATE_DIR") or os.path.join(_PY_APPS, "_intel", "foreman")


def _now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def state_path(task_id):
    return os.path.join(STATE_DIR, f"{task_id}.json")


def load_state(task_id):
    try:
        with open(state_path(task_id), "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def save_state(state):
    """Escritura atomica (tmp + replace). Un fallo de disco se reporta pero no mata la supervision."""
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
        path = state_path(state["task_id"])
        tmp = f"{path}.{os.getpid()}.tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(state, f, indent=2, ensure_ascii=False)
        for attempt in range(5):
            try:
                os.replace(tmp, path)
                return True
            except PermissionError:  # el watcher puede tenerlo abierto un instante (Windows)
                time.sleep(0.2 * (attempt + 1))
        os.remove(tmp)
    except OSError as e:
        sys.stderr.write(f"[foreman] no se pudo escribir estado de {state.get('task_id')}: {e}\n")
    return False

def read_terminal_screen(term_id):
    """Reads the current rendered screen of an Orca terminal."""
    try:
        cmd = ["orca", "terminal", "read", "--terminal", term_id, "--screen", "--json"]
        res = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
        if res.returncode == 0:
            data = json.loads(res.stdout)
            res_obj = data.get("result", {})
            lines = res_obj.get("terminal", {}).get("tail", [])
            if not lines:
                lines = res_obj.get("lines", [])
            return "\n".join(lines)
    except Exception as e:
        sys.stderr.write(f"Error reading terminal {term_id}: {e}\n")
    return ""

def notify_orchestrator(message):
    """Sends notification to the Orchestrator terminal."""
    if os.path.exists(ORCHESTRATOR_NOTIFIER):
        try:
            res = subprocess.run([sys.executable, ORCHESTRATOR_NOTIFIER, message], check=False)
            if res.returncode != 0:
                # notify_orchestrator ya lo dejo en _intel/foreman/outbox.jsonl; foreman_watch reintenta.
                sys.stderr.write(f"[foreman] notificacion no entregada (rc={res.returncode}); quedo en outbox\n")
        except Exception as e:
            sys.stderr.write(f"Error running notify_orchestrator: {e}\n")


# T-0555: lane orchestrators close with [SUBORCH_DONE] (same grammar as [WORKER_DONE]); a Foreman
# supervising a lane-orchestrator terminal must recognize both. --sentinel narrows this on demand.
SENTINEL_TAGS = {"worker": ("WORKER_DONE",), "suborch": ("SUBORCH_DONE",), "both": ("WORKER_DONE", "SUBORCH_DONE")}


def build_sentinel_re(mode="both"):
    tags = SENTINEL_TAGS.get(mode, SENTINEL_TAGS["both"])
    return re.compile(r"\[(?:%s)\]\s+task_id=([^\s<>]+)\s+outcome=(succeeded|failed)(.*)" % "|".join(tags))


SENTINEL_RE = build_sentinel_re("both")  # default: every existing caller (codex_worker.py, tests) keeps matching WORKER_DONE
# Lineas que son ECO de un despacho/instruccion del orquestador, no un cierre del worker.
# T-0555: se suman los placeholders literales del bloque de cierre SUBORCH_* citado en un brief
# (misma logica que orca-census.cjs: mismo filtro, extendido en ambos lados a la vez).
ECHO_MARKERS = ("[ORCHESTRATOR]", "[MISSION]", "[MISI", "emiti", "emití", "report=<",
                "task_id=T-NNNN", "q='<", "outcome=succeeded|failed", "running=<ids>")

SUBORCH_QUESTION_RE = re.compile(r"\[SUBORCH_QUESTION\]\s+task_id=([^\s<>]+)\s+q=(.+)")


def find_worker_done(screen, task_id, sentinel_re=None):
    """(task_id, outcome, extra) del ULTIMO cierre real en pantalla, o None.
    Ignora el texto plantilla y el eco de instrucciones (2026-09-22: dos falsos positivos).
    sentinel_re (T-0555) por defecto matchea WORKER_DONE y SUBORCH_DONE; ver build_sentinel_re."""
    found = None
    pattern = sentinel_re or SENTINEL_RE
    for line in screen.splitlines():
        if any(m in line for m in ECHO_MARKERS):
            continue
        m = pattern.search(line)
        if m and (task_id in m.group(1) or m.group(1) == task_id):
            found = (m.group(1), m.group(2), m.group(3).strip())
    return found


def find_suborch_question(screen):
    """(task_id, q) de la ULTIMA [SUBORCH_QUESTION] real en pantalla, o None (T-0555).
    Mismo filtro de eco que find_worker_done."""
    found = None
    for line in screen.splitlines():
        if any(m in line for m in ECHO_MARKERS):
            continue
        m = SUBORCH_QUESTION_RE.search(line)
        if m:
            q = m.group(2).strip()
            if len(q) >= 2 and q[0] == q[-1] and q[0] in ("'", '"'):
                q = q[1:-1]
            found = (m.group(1), q)
    return found

# T-0548: el worker declara en su bloque criteria el modelo/effort que realmente corrio.
# Se toma la ULTIMA ocurrencia real; un valor con '<' es la plantilla del despacho que quedo
# como eco en pantalla (task_router la escribe asi a proposito), no la respuesta del worker.
MODEL_EFFORT_RE = re.compile(r"model_effort_used:\s*`?([^\s`]+)")
LEDGER_CJS = os.environ.get("WEZBRIDGE_LEDGER_PATH") or os.path.join(_PY_APPS, "_docs-curation", "ledger.cjs")
CARD_ID_RE = re.compile(r"^T-\d{4}$")


def find_model_effort_used(screen):
    found = None
    for line in screen.splitlines():
        for m in MODEL_EFFORT_RE.finditer(line):
            val = m.group(1).strip().rstrip(".,;")
            if val and "<" not in val and ">" not in val:
                found = val
    return found


def record_model_effort(task_id, value, state=None):
    """Escribe model_effort_used en el estado y lo SUMA a la evidencia de la tarjeta.
    Solo para ids de ledger (T-NNNN). Un fallo del ledger se reporta y no mata la supervision."""
    if not value:
        return False
    if state is not None:
        state["model_effort_used"] = value
    if not CARD_ID_RE.match(task_id or ""):
        return False
    try:
        res = subprocess.run(["node", LEDGER_CJS, "update", task_id, "--evidence-append",
                              f"model_effort_used: {value} (Foreman {_now_iso()})"],
                             capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30)
        if res.returncode != 0:
            sys.stderr.write(f"[foreman] ledger no registro model_effort_used de {task_id}: {res.stderr.strip()}\n")
            return False
        if state is not None:
            state["model_effort_recorded"] = True
        return True
    except (OSError, subprocess.SubprocessError) as e:
        sys.stderr.write(f"[foreman] ledger no disponible para {task_id}: {e}\n")
        return False


def _finish(state, status, outcome=None, report=None):
    if state is None:
        return
    state.update({"status": status, "outcome": outcome, "report": report, "finished_at": _now_iso()})
    save_state(state)


def _close(task_id, screen, state, outcome, extra):
    """Cierre real: registra model_effort_used (si el worker lo declaro) antes de persistir."""
    record_model_effort(task_id, find_model_effort_used(screen), state)
    _finish(state, "done", outcome, extra)


def supervise_task(task_id, term_id, max_wait_sec=300, poll_interval=10, deadline=None, state=None, sentinel="both"):
    """Polls a worker terminal until [WORKER_DONE]/[SUBORCH_DONE] is detected or timeout.
    deadline (epoch) manda sobre max_wait_sec: un --resume conserva el deadline original.
    state (dict) se persiste en cada poll; None = sin persistencia (compatibilidad).
    sentinel (T-0555): 'worker' (solo WORKER_DONE), 'suborch' (solo SUBORCH_DONE) o 'both' (default,
    compatibilidad con toda supervision existente)."""
    if deadline is None:
        deadline = time.time() + max_wait_sec
    last_prompt_nudge = 0
    sentinel_re = build_sentinel_re(sentinel)
    # JSON no tiene tuplas: lo persistido vuelve como lista; se normaliza para que la
    # comparacion de dedupe contra el tuple de find_suborch_question funcione tras un --resume.
    _prev_q = state.get("_last_forwarded_question") if state is not None else None
    last_forwarded_question = tuple(_prev_q) if _prev_q else None

    print(f"[*] Foreman supervisando '{task_id}' en {term_id} (timeout: {max_wait_sec}s, "
          f"restan {max(0, int(deadline - time.time()))}s)...", flush=True)

    while time.time() < deadline:
        time.sleep(max(0, min(poll_interval, deadline - time.time())))
        screen = read_terminal_screen(term_id)
        if state is not None:
            state["last_poll"] = _now_iso()
            state["last_screen_sha1"] = hashlib.sha1(screen.encode("utf-8", "replace")).hexdigest()
            save_state(state)

        # 1. Check for WORKER_DONE/SUBORCH_DONE. outcome tiene que ser literal succeeded|failed:
        #    el texto plantilla del despacho (outcome=<succeeded|failed>) queda eco en
        #    pantalla y disparaba un falso positivo (medido 2026-09-22, T-0511).
        hit = find_worker_done(screen, task_id, sentinel_re=sentinel_re)
        if hit:
            done_task_id, outcome, extra = hit
            print(f"[+] Task {task_id} completada por worker! Outcome: {outcome}")
            _close(task_id, screen, state, outcome, extra)
            notify_orchestrator(f"[WORKER_DONE] task_id={task_id} outcome={outcome} {extra}")
            return {"status": "completed", "outcome": outcome, "details": extra}

        # 1b. [SUBORCH_QUESTION] (T-0555): una lane orchestrator supervisada pide una decision.
        #     Se reenvia una sola vez por pregunta (dedupe por texto exacto, no por tiempo: a
        #     diferencia del nudge de confirmacion, esto no es un timer de reintento).
        q_hit = find_suborch_question(screen)
        if q_hit and q_hit != last_forwarded_question:
            q_task_id, q_text = q_hit
            notify_orchestrator(f"[SUBORCH_QUESTION] task_id={q_task_id} q='{q_text}'")
            last_forwarded_question = q_hit
            if state is not None:
                state["_last_forwarded_question"] = list(q_hit)
                save_state(state)

        # 2. Check if stuck on confirmation
        stuck_phrases = [
            "do you want to proceed",
            "should i proceed",
            "waiting for confirmation",
            "press enter to continue",
            "(Y/N)"
        ]
        lower_screen = screen.lower()
        if any(p in lower_screen for p in stuck_phrases):
            # NUNCA auto-confirmar: un "Do you want to proceed?" puede ser un dialogo de permiso
            # sobre una operacion destructiva (2026-09-22: reescritura de historia git en el pod RF;
            # el guard de Orca bloqueo 6 nudges de esta rama). Se avisa al orquestador y se espera.
            if time.time() - last_prompt_nudge > 1800:
                print(f"[!] Worker en {term_id} espera confirmacion. Avisando al orquestador (sin auto-confirmar).")
                notify_orchestrator(f"[FOREMAN_STUCK] task_id={task_id} en {term_id}: el worker muestra un prompt de confirmacion. Revisalo vos; Foreman no confirma.")
                last_prompt_nudge = time.time()

    # Final check before timeout to avoid race condition
    final_screen = read_terminal_screen(term_id)
    hit = find_worker_done(final_screen, task_id, sentinel_re=sentinel_re)
    if hit:
        done_task_id, outcome, extra = hit
        print(f"[+] Task {task_id} completada por worker en chequeo final! Outcome: {outcome}")
        _close(task_id, final_screen, state, outcome, extra)
        notify_orchestrator(f"[WORKER_DONE] task_id={task_id} outcome={outcome} {extra}")
        return {"status": "completed", "outcome": outcome, "details": extra}

    print(f"[-] Timeout alcanzado para task {task_id}.")
    _finish(state, "timeout")
    notify_orchestrator(f"[FOREMAN_TIMEOUT] task_id={task_id} en {term_id} superó {max_wait_sec}s sin emitir WORKER_DONE.")
    return {"status": "timeout"}

def main(argv=None):
    parser = argparse.ArgumentParser(description="Foreman Supervisor")
    parser.add_argument("--task-id", help="Task ID being supervised")
    parser.add_argument("--terminal", help="Worker terminal handle (e.g. term_...)")
    parser.add_argument("--timeout", type=int, default=300, help="Max wait seconds")
    parser.add_argument("--resume", metavar="TASK_ID",
                        help="Reanudar desde _intel/foreman/<TASK_ID>.json conservando terminal y deadline")
    parser.add_argument("--fresh", action="store_true",
                        help="Ignorar un estado 'supervising' previo y reiniciar el timeout")
    parser.add_argument("--sentinel", choices=sorted(SENTINEL_TAGS.keys()), default="both",
                        help="Que sentinel de cierre esperar: worker ([WORKER_DONE]), "
                             "suborch ([SUBORCH_DONE], T-0555) o both (default, ambos)")
    args = parser.parse_args(argv)
    run(args, parser)


def run(args, parser):
    task_id = args.resume or args.task_id
    if not task_id:
        parser.error("--task-id es obligatorio (o --resume TASK_ID)")

    prev = load_state(task_id)
    if args.resume and (prev is None or not prev.get("terminal") or not prev.get("deadline_epoch")):
        parser.error(f"--resume {task_id}: no hay estado valido en {state_path(task_id)}")
    # Reanudar si se pidio, o automaticamente si hay una supervision previa sin cerrar para la
    # misma terminal (el Foreman anterior murio con su sesion): el timeout NO se reinicia.
    resume = bool(args.resume) or (
        not args.fresh and prev is not None
        and prev.get("status") in ("supervising", "orphaned")
        and bool(prev.get("deadline_epoch"))
        and (not args.terminal or prev.get("terminal") == args.terminal))

    if resume:
        state = prev
        terminal = prev["terminal"]
        deadline = float(prev["deadline_epoch"])
        max_wait = int(prev.get("timeout_sec", args.timeout))
        state["resumed_at"] = _now_iso()
        print(f"[*] Reanudando supervision de {task_id} (deadline original {prev.get('deadline')}).", flush=True)
    else:
        if not args.terminal:
            parser.error("--terminal es obligatorio salvo con --resume")
        terminal = args.terminal
        max_wait = args.timeout
        deadline = time.time() + max_wait
        state = {"task_id": task_id, "terminal": terminal, "started_at": _now_iso(),
                 "timeout_sec": max_wait, "deadline_epoch": deadline,
                 "deadline": datetime.fromtimestamp(deadline, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                 "last_poll": None, "last_screen_sha1": None,
                 "resume_count": 0, "outcome": None, "report": None}
    state.update({"pid": os.getpid(), "status": "supervising"})
    save_state(state)
    return supervise_task(task_id, terminal, max_wait_sec=max_wait, deadline=deadline, state=state,
                           sentinel=getattr(args, "sentinel", "both"))

if __name__ == "__main__":
    main()

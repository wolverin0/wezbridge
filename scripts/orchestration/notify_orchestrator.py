#!/usr/bin/env python3
"""
notify_orchestrator.py
Sends an automated report/message to the active Orchestrator terminal (wezbridge lane).

T-0596 paso 2: delivery goes through bin/a2a-send-cli.cjs (the wezbridge a2a_send control
plane — dispatch gate, result-shape check, lease, durable queue, self-send guard, audit),
NOT a hand-rolled `orca terminal send` with its own census/title-matching logic. The
resolver (WezTerm pane -> Orca terminal, project/lane name, never a hardcoded handle) is
the SAME one a2a_send and queue-drain use (src/orca-target.cjs / src/pane-identity.cjs);
this file no longer duplicates it.
"""

import sys
import json
import subprocess
import os
import time
from datetime import datetime, timezone

# Cola en disco (T-0524): una entrega fallida NO se pierde. Queda en outbox.jsonl y
# foreman_watch.py (Task Scheduler, cada 5 min) la reintenta; a los 3 intentos fallidos
# tambien sale por ntfy (src/ntfy-notifier.cjs) si NTFY_TOPIC esta configurado.
_PY_APPS = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".."))
_REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
STATE_DIR = os.environ.get("FOREMAN_STATE_DIR") or os.path.join(_PY_APPS, "_intel", "foreman")
# T-0596 paso 2: the orchestrator is addressed by PROJECT/lane name (alias map already
# resolves 'orch'/'orchestrator'/'pauol' -> 'wezbridge' in pane-identity.cjs), never a
# hardcoded terminal handle — a2a-send-cli.cjs resolves the live pane/terminal at send time.
ORCHESTRATOR_PROJECT = os.environ.get("ORCHESTRATOR_PROJECT") or "wezbridge"
A2A_SEND_CLI = os.environ.get("A2A_SEND_CLI") or os.path.join(_REPO, "bin", "a2a-send-cli.cjs")
NODE_BIN = os.environ.get("WEZBRIDGE_NODE_BIN") or "node"
NTFY_NOTIFIER = os.path.join(_REPO, "src", "ntfy-notifier.cjs")
NTFY_AFTER_ATTEMPTS = 3
CMD_TIMEOUT = 30

LAST_ERROR = None  # motivo del ultimo fallo, para la linea de diagnostico


def outbox_path():
    return os.path.join(STATE_DIR, "outbox.jsonl")


def _now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class _OutboxLock:
    """Lock por archivo (O_EXCL): foreman.py agrega mientras foreman_watch.py reescribe."""
    def __enter__(self):
        os.makedirs(STATE_DIR, exist_ok=True)
        self.path = outbox_path() + ".lock"
        for _ in range(100):
            try:
                self.fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                return self
            except FileExistsError:
                try:
                    if time.time() - os.path.getmtime(self.path) > 60:  # lock huerfano
                        os.remove(self.path)
                        continue
                except OSError:
                    pass
                time.sleep(0.1)
        raise TimeoutError(f"outbox lock ocupado: {self.path}")

    def __exit__(self, *exc):
        os.close(self.fd)
        try:
            os.remove(self.path)
        except OSError:
            pass


def read_outbox():
    try:
        with open(outbox_path(), "r", encoding="utf-8") as f:
            return [json.loads(line) for line in f if line.strip()]
    except FileNotFoundError:
        return []


def _write_outbox(entries):
    tmp = outbox_path() + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        for e in entries:
            f.write(json.dumps(e, ensure_ascii=False) + "\n")
    os.replace(tmp, outbox_path())


def enqueue(message, reason, attempts=1):
    entry = {"ts": _now_iso(), "message": message, "attempts": attempts,
             "last_error": reason, "last_attempt": _now_iso(), "ntfy_sent": False}
    with _OutboxLock():
        with open(outbox_path(), "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    return entry


def deliver(message, to_project=None):
    """Un intento de entrega a la terminal del orquestador, via bin/a2a-send-cli.cjs
    (el control plane completo de a2a_send: resuelve WezTerm o Orca por proyecto/lane,
    nunca un handle fijo). (ok, motivo)."""
    global LAST_ERROR
    LAST_ERROR = None
    project = to_project or ORCHESTRATOR_PROJECT
    cmd = [NODE_BIN, A2A_SEND_CLI, "--to-project", project, "--type", "progress", "--body", message]
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace",
                             timeout=CMD_TIMEOUT)
    except Exception as e:
        return False, f"a2a-send-cli fallo: {type(e).__name__}: {e}"
    if res.returncode == 0:
        return True, f"entregado a {project} (a2a-send-cli)"
    return False, f"a2a-send-cli rc={res.returncode}: {((res.stdout or '') + (res.stderr or '')).strip()[:200]}"


def send_ntfy(message):
    """Fallback por ntfy (src/ntfy-notifier.cjs; requiere NTFY_TOPIC). (ok, motivo)."""
    if not os.path.exists(NTFY_NOTIFIER):
        return False, f"no existe {NTFY_NOTIFIER}"
    try:
        res = subprocess.run(["node", NTFY_NOTIFIER, "WezBridge Foreman", message, "high"],
                             capture_output=True, text=True, encoding="utf-8", errors="replace",
                             timeout=CMD_TIMEOUT)
    except Exception as e:
        return False, f"ntfy fallo: {type(e).__name__}: {e}"
    if res.returncode == 0:
        return True, "ntfy ok"
    return False, f"ntfy rc={res.returncode}: {((res.stderr or '') + (res.stdout or '')).strip()[:200]}"


def notify(message, to_project=None, queue=True):
    """Entrega o encola. Devuelve True/False e imprime UNA linea con el motivo."""
    ok, reason = deliver(message, to_project)
    if ok:
        print(f"[notify] ok: {reason}")
        return True
    if queue:
        try:
            enqueue(message, reason)
            print(f"[notify] FALLO ({reason}); encolado en {outbox_path()}")
        except Exception as e:  # ultimo recurso: que quede al menos en stderr/log
            print(f"[notify] FALLO ({reason}); NO se pudo encolar ({e}): {message}")
    else:
        print(f"[notify] FALLO ({reason})")
    return False


def drain_outbox():
    """Reintenta la cola. Lo entregado sale de la cola (y queda en outbox.delivered.jsonl);
    lo que falla suma intentos y, desde el 3er intento, se manda una vez por ntfy.
    Nada se borra sin haberse entregado a la terminal. Devuelve (entregados, pendientes).
    Las entregas corren FUERA del lock (orca puede tardar); lo que se encolo mientras tanto
    se conserva al reescribir."""
    with _OutboxLock():
        entries = read_outbox()
    if not entries:
        return 0, 0
    pending, delivered = [], []
    for e in entries:
        ok, reason = deliver(e["message"])
        e["last_attempt"] = _now_iso()
        if ok:
            e["delivered_at"] = e["last_attempt"]
            delivered.append(e)
            continue
        e["attempts"] = int(e.get("attempts", 0)) + 1
        e["last_error"] = reason
        if e["attempts"] >= NTFY_AFTER_ATTEMPTS and not e.get("ntfy_sent"):
            nok, nreason = send_ntfy(e["message"])
            e["ntfy_sent"] = nok
            e["ntfy_error"] = None if nok else nreason
        pending.append(e)
    with _OutboxLock():
        arrived = read_outbox()[len(entries):]  # encolados durante el drain
        _write_outbox(pending + arrived)
        if delivered:
            with open(os.path.join(STATE_DIR, "outbox.delivered.jsonl"), "a", encoding="utf-8") as f:
                for e in delivered:
                    f.write(json.dumps(e, ensure_ascii=False) + "\n")
    print(f"[notify] outbox: {len(delivered)} entregados, {len(pending) + len(arrived)} pendientes")
    return len(delivered), len(pending) + len(arrived)


if __name__ == "__main__":
    if len(sys.argv) > 1:
        msg = " ".join(sys.argv[1:])
    else:
        msg = "Notification from Orca task."
    sys.exit(0 if notify(msg) else 1)
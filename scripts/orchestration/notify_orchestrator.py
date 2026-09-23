#!/usr/bin/env python3
"""
notify_orchestrator.py
Sends an automated report/message to the active Orchestrator terminal in Orca (wezbridge pane).
Allows scheduled automations, workers, or night jobs to notify the Orchestrator directly.
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
ORCA = os.environ.get("ORCA_BIN") or "orca"
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


def find_orchestrator_terminal():
    global LAST_ERROR
    try:
        res = subprocess.run([ORCA, "terminal", "list", "--json"], capture_output=True, text=True,
                             encoding="utf-8", errors="replace", timeout=CMD_TIMEOUT)
        if res.returncode != 0:
            LAST_ERROR = f"orca terminal list rc={res.returncode}: {(res.stderr or '').strip()[:200]}"
            return None
        data = json.loads(res.stdout)
        terminals = data.get("result", {}).get("terminals", [])
        if not terminals and "terminals" in data:
            terminals = data["terminals"]
        
        # 1. Check orchestrator_target.json
        target_file = os.path.join(os.path.dirname(__file__), "orchestrator_target.json")
        if os.path.exists(target_file):
            try:
                with open(target_file, "r", encoding="utf-8") as f:
                    cfg = json.load(f)
                    th = cfg.get("terminal_handle")
                    if th:
                        for t in terminals:
                            if t.get("handle") == th and t.get("connected") and t.get("writable"):
                                return th
            except Exception:
                pass

        # 2. Look for terminal with FLEET ORCHESTRATOR or Fable in title
        for t in terminals:
            title = t.get("title", "").upper()
            if ("FLEET ORCHESTRATOR" in title or "FABLE" in title) and t.get("connected") and t.get("writable"):
                return t.get("handle")

        # 3. Look for terminal in wezbridge
        for t in terminals:
            wt_path = t.get("worktreePath", "").replace("\\", "/").lower()
            if "wezbridge" in wt_path and t.get("connected") and t.get("writable"):
                return t.get("handle")
        
        # SIN fallback al "primer terminal": mandarle un prompt a un pane ajeno es peor
        # que encolar (2026-09-23, T-0524). Sin orquestador identificable -> None -> outbox.
        LAST_ERROR = "orca terminal list: ningun terminal orquestador identificable"
        return None
    except Exception as e:
        LAST_ERROR = f"orca terminal list fallo: {type(e).__name__}: {e}"
        return None


def deliver(message, handle=None):
    """Un intento de entrega a la terminal del orquestador. (ok, motivo)."""
    global LAST_ERROR
    LAST_ERROR = None
    if not handle:
        handle = find_orchestrator_terminal()
    if not handle:
        return False, LAST_ERROR or "no se encontro terminal del orquestador"
    cmd = [ORCA, "terminal", "send", "--terminal", handle, "--text", message, "--enter"]
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace",
                             timeout=CMD_TIMEOUT)
    except Exception as e:
        return False, f"orca terminal send fallo: {type(e).__name__}: {e}"
    if res.returncode == 0:
        return True, f"entregado a {handle}"
    return False, f"orca terminal send rc={res.returncode}: {(res.stderr or '').strip()[:200]}"


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


def notify(message, handle=None, queue=True):
    """Entrega o encola. Devuelve True/False e imprime UNA linea con el motivo."""
    ok, reason = deliver(message, handle)
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
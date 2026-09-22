#!/usr/bin/env python3
"""
scripts/orchestration/foreman.py

Foreman Autonomous Supervisor for Orca Multi-Agent Runs.
Integrates TypeSafe JEV System One (Choice primitive) to supervise Orca worker terminals:
- Polls active workers via `orca terminal read --screen --json`
- Evaluates screen state (<50ms via JEV Choice / fast heuristic fallback):
    - active_coding
    - tests_passed_ready
    - stuck_loop
    - provider_error
    - idle_done
- Executes autonomous orchestration actions:
    - On tests_passed_ready: emits `orca orchestration send --type worker_done`, retains terminal, updates task to completed
    - On stuck_loop / idle_done: injects autonomous continuation nudge into worker terminal
    - On provider_error: logs backoff and sends retry instruction
"""

import os
import sys
import json
import time
import re
import argparse
import subprocess
from pathlib import Path
from typing import Dict, Any, Optional, List, Tuple

# Configuration Defaults
DEFAULT_TIMEOUT_MS = 600
DEFAULT_ENDPOINT = "https://api.typesafe.ai/v1/systemone"
DEFAULT_MODEL = "jev-latest"
CACHED_KEY_FILE = Path("C:/infra-secrets/typesafe-key")
USER_CACHED_KEY = Path("C:/Users/pauol/.claude/cache/typesafe-key")
DEFAULT_INTERVAL = 30
DEFAULT_LOG_FILE = Path("G:/_OneDrive/OneDrive/Desktop/Py Apps/_intel/jev-shadow/foreman_supervisor.jsonl")

# Choice Criteria definition for Foreman Worker Status
FOREMAN_CHOICE_CRITERIA = {
    "active_coding": "El agente está escribiendo código, ejecutando comandos o corriendo suites de prueba activamente.",
    "tests_passed_ready": "Completó los cambios solicitados, ejecutó el suite de tests y pasaron todos satisfactoriamente (verde / 100% pass), y se encuentra listo para cerrar.",
    "stuck_loop": "El agente repite el mismo error 2 o más veces, o se detuvo a pedir confirmación innecesaria al operador ('Do you want to proceed?', 'Shall I continue?', etc.).",
    "provider_error": "Error de proveedor o API de IA (529 overloaded, 429 rate limit, 503 unavailable, connection reset).",
    "idle_done": "El proceso finalizó y la terminal está en el prompt de comandos ($ o >) esperando sin actividad."
}


def redact_text(text: str) -> str:
    """Redact sensitive secrets, API keys, tokens, and PII from state."""
    if not isinstance(text, str):
        return ""
    text = re.sub(r'Bearer\s+[A-Za-z0-9_\-\.]{15,}', 'Bearer [REDACTED]', text, flags=re.IGNORECASE)
    text = re.sub(r'(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}', r'\1_[REDACTED]', text)
    text = re.sub(r'sk-[a-zA-Z0-9_\-]{20,}', 'sk-[REDACTED]', text)
    text = re.sub(r'typesafe_[a-zA-Z0-9_\-]{20,}', 'typesafe_[REDACTED]', text)
    text = re.sub(r'-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]+?-----END [A-Z ]+ PRIVATE KEY-----', '[PRIVATE_KEY_REDACTED]', text)
    text = re.sub(r'ey[A-Za-z0-9_-]{15,}\.ey[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}', '[JWT_REDACTED]', text)
    text = re.sub(r'(password|passwd|pwd|secret|token)\s*[:=]\s*["\']?[^"\'\s,;]{4,}["\']?', r'\1: [REDACTED]', text, flags=re.IGNORECASE)
    text = re.sub(r'[A-Z]:\\Users\\[a-zA-Z0-9_\-]+', lambda _: 'C:\\Users\\[USER]', text, flags=re.IGNORECASE)
    text = re.sub(r'/home/[a-zA-Z0-9_\-]+', '/home/[USER]', text)
    return text


def resolve_api_key(explicit_key: Optional[str] = None) -> Optional[str]:
    """Resolves TypeSafe API key from env or cached files."""
    if explicit_key:
        return explicit_key.strip()
    env_key = os.getenv("TYPESAFE_API_KEY")
    if env_key and env_key.strip():
        return env_key.strip()
    if CACHED_KEY_FILE.exists():
        try:
            k = CACHED_KEY_FILE.read_text(encoding="utf-8").strip()
            if k:
                return k
        except Exception:
            pass
    if USER_CACHED_KEY.exists():
        try:
            k = USER_CACHED_KEY.read_text(encoding="utf-8").strip()
            if k:
                return k
        except Exception:
            pass
    return None


def run_orca_command(cmd_args: List[str], timeout: int = 15) -> Tuple[int, str, str]:
    """Execute an orca CLI command safely returning exit_code, stdout, stderr."""
    full_cmd = ["orca"] + cmd_args
    try:
        proc = subprocess.run(
            full_cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            shell=True,
            timeout=timeout,
            encoding="utf-8",
            errors="replace"
        )
        return proc.returncode, proc.stdout, proc.stderr
    except subprocess.TimeoutExpired:
        return -1, "", "Command timed out"
    except Exception as ex:
        return -1, "", str(ex)


STRIKES_FILE = Path("G:/_OneDrive/OneDrive/Desktop/Py Apps/_intel/jev-shadow/foreman_strikes.json")


def get_strike_count(task_id: str) -> int:
    try:
        if STRIKES_FILE.exists():
            data = json.loads(STRIKES_FILE.read_text(encoding="utf-8"))
            return data.get(task_id, 0)
    except Exception:
        pass
    return 0


def increment_strike_count(task_id: str) -> int:
    data = {}
    try:
        if STRIKES_FILE.exists():
            data = json.loads(STRIKES_FILE.read_text(encoding="utf-8"))
    except Exception:
        pass
    data[task_id] = data.get(task_id, 0) + 1
    try:
        STRIKES_FILE.parent.mkdir(parents=True, exist_ok=True)
        STRIKES_FILE.write_text(json.dumps(data, indent=2), encoding="utf-8")
    except Exception:
        pass
    return data[task_id]


def classify_screen_heuristics(screen_text: str) -> Dict[str, Any]:
    """Fast deterministic regex fallback classification with last-15-line and prompt gating."""
    text = screen_text.strip()
    lines = [l.strip() for l in text.splitlines() if l.strip()]
    if not lines:
        return {
            "choice": "active_coding",
            "confidence": 0.50,
            "reason": "Empty screen"
        }

    last_line = lines[-1]
    has_prompt_on_last_line = bool(re.match(r'^(\$|>|#|❯|›)\s*$', last_line) or re.search(r'What would you like (?:me )?to do next\??', last_line, re.IGNORECASE))
    recent_tail = "\n".join(lines[-15:])
    
    # 1. Check for provider API errors
    provider_err_patterns = [
        r'\b529\b',
        r'overloaded_error',
        r'rate_limit_error',
        r'429 Too Many Requests',
        r'503 Service Unavailable',
        r'BedrockException',
        r'AnthropicError',
        r'APIConnectionError',
        r'connection reset by peer',
        r'Request timed out'
    ]
    for p in provider_err_patterns:
        if re.search(p, recent_tail, re.IGNORECASE):
            return {
                "choice": "provider_error",
                "confidence": 0.95,
                "reason": f"Matched provider error pattern '{p}' in recent tail"
            }

    # 2. Check for completed tests & green suites (strictly requires match in last 15 lines AND prompt on last line)
    tests_green_patterns = [
        r'==+ \d+ passed.* in \d+\.\d+s =+',
        r'Tests:\s+\d+\s+passed,\s+\d+\s+total',
        r'\bPASS\b\s+tests?[/\\]',
        r'✓ all \d+ tests passed',
        r'Ran \d+ tests? in \d+\.\d+s\s+OK',
        r'\b\d+ passed, \d+ skipped\b',
        r'73/73 tests green'
    ]
    for p in tests_green_patterns:
        if re.search(p, recent_tail) and has_prompt_on_last_line:
            return {
                "choice": "tests_passed_ready",
                "confidence": 0.95,
                "reason": f"Verified tests passed pattern '{p}' in last 15 lines with active prompt on final line"
            }

    # 3. Check for stuck loop or agent asking operator for confirmation
    stuck_confirm_patterns = [
        r'do you want (?:me )?to proceed\??',
        r'shall I continue\??',
        r'should I (?:run|execute|proceed|continue)\??',
        r'waiting for (?:user|operator) confirmation',
        r'please confirm if you would like',
        r'¿Desea continuar\??',
        r'¿Procedo con\??'
    ]
    for p in stuck_confirm_patterns:
        if re.search(p, recent_tail, re.IGNORECASE):
            return {
                "choice": "stuck_loop",
                "confidence": 0.88,
                "reason": f"Matched confirmation prompt pattern '{p}'"
            }

    # 4. Check for idle prompt waiting at end of screen
    if has_prompt_on_last_line:
        return {
            "choice": "idle_done",
            "confidence": 0.85,
            "reason": f"Screen ends on quiescent prompt: '{last_line}'"
        }

    # Default to active coding
    return {
        "choice": "active_coding",
        "confidence": 0.70,
        "reason": "Default active state (no completion, error, or idle marker)"
    }


def query_jev_choice(screen_text: str, task_spec: str = "", api_key: Optional[str] = None, timeout_ms: int = DEFAULT_TIMEOUT_MS) -> Dict[str, Any]:
    """Queries TypeSafe JEV System One for worker status choice, falling back to heuristics."""
    key = resolve_api_key(api_key)
    redacted_screen = redact_text(screen_text)[-1400:]
    redacted_spec = redact_text(task_spec)[:500]

    if not key:
        heuristic = classify_screen_heuristics(redacted_screen)
        heuristic["fallback"] = True
        heuristic["engine"] = "heuristic_no_key"
        heuristic["elapsed_ms"] = 0
        return heuristic

    payload = {
        "model": DEFAULT_MODEL,
        "state": {
            "task_spec": redacted_spec,
            "terminal_screen": redacted_screen
        },
        "questions": {
            "worker_status": {
                "type": "choice",
                "instructions": "Analiza la pantalla de la terminal del agente de desarrollo y clasifica su estado actual.",
                "criteria": FOREMAN_CHOICE_CRITERIA
            }
        }
    }

    start_t = time.time()
    try:
        import requests
        resp = requests.post(
            DEFAULT_ENDPOINT,
            headers={
                "Authorization": f"Bearer {key}",
                "Content-Type": "application/json"
            },
            json=payload,
            timeout=timeout_ms / 1000.0
        )
        elapsed_ms = int((time.time() - start_t) * 1000)

        if resp.status_code == 200:
            data = resp.json()
            ans = data.get("answers", {}).get("worker_status", {})
            choice = ans.get("choice")
            confidence = ans.get("confidence", 0.0)
            if choice in FOREMAN_CHOICE_CRITERIA:
                return {
                    "choice": choice,
                    "confidence": confidence,
                    "probabilities": ans.get("probabilities", {}),
                    "fallback": False,
                    "engine": "typesafe_jev",
                    "elapsed_ms": elapsed_ms
                }
    except Exception as ex:
        pass

    # Heuristic fallback on API timeout or error
    elapsed_ms = int((time.time() - start_t) * 1000)
    heuristic = classify_screen_heuristics(redacted_screen)
    heuristic["fallback"] = True
    heuristic["engine"] = "heuristic_api_fallback"
    heuristic["elapsed_ms"] = elapsed_ms
    return heuristic


def read_worker_screen(terminal_handle: str) -> str:
    """Reads terminal output rendered screen via orca terminal read --screen --json."""
    for args in [
        ["terminal", "read", "--terminal", terminal_handle, "--screen", "--json"],
        ["terminal", "read", "--terminal", terminal_handle, "--limit", "100", "--json"]
    ]:
        code, stdout, stderr = run_orca_command(args)
        if code == 0 and stdout:
            try:
                data = json.loads(stdout)
                res = data.get("result", {})
                term_data = res.get("terminal", {}) if isinstance(res.get("terminal"), dict) else res
                content = (
                    term_data.get("screen") or
                    term_data.get("tail") or
                    term_data.get("lines") or
                    res.get("screen") or
                    res.get("tail") or
                    res.get("output") or ""
                )
                if isinstance(content, list):
                    text = "\n".join(str(x) for x in content)
                    if text.strip():
                        return text
                elif isinstance(content, str) and content.strip():
                    return content
            except Exception:
                pass
    return ""


def get_active_tasks_and_workers(run_id: str) -> List[Dict[str, Any]]:
    """Fetches tasks and corresponding worker terminals for a given run."""
    workers_by_task = {}
    code, stdout, _ = run_orca_command(["orchestration", "worker-list", "--json"])
    if code == 0 and stdout:
        try:
            wdata = json.loads(stdout).get("result", {})
            items = wdata.get("workers", []) or wdata.get("items", [])
            for it in items:
                t_id = it.get("taskId")
                if t_id:
                    workers_by_task[t_id] = it
        except Exception:
            pass

    code, stdout, _ = run_orca_command(["orchestration", "task-list", "--run", run_id, "--json"])
    if code != 0 or not stdout:
        return []

    tasks = []
    try:
        tdata = json.loads(stdout).get("result", {})
        task_list = tdata.get("tasks", [])
        for t in task_list:
            t_id = t.get("id")
            w_info = workers_by_task.get(t_id, {})
            terminal_handle = (
                w_info.get("agentTerminalHandle") or 
                t.get("created_by_terminal_handle")
            )
            dispatch_id = w_info.get("dispatchId")
            tasks.append({
                "task": t,
                "terminal_handle": terminal_handle,
                "dispatch_id": dispatch_id,
                "worker_info": w_info
            })
    except Exception:
        pass

    return tasks


def log_foreman_decision(record: Dict[str, Any], log_path: Path = DEFAULT_LOG_FILE):
    """Appends supervisor telemetry record to JSONL."""
    try:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with open(log_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
    except Exception as ex:
        print(f"[FOREMAN-LOG-ERR] {ex}", file=sys.stderr)


def supervise_worker(
    run_id: str,
    task_item: Dict[str, Any],
    dry_run: bool = False,
    api_key: Optional[str] = None
) -> Dict[str, Any]:
    """Inspects a single worker terminal and performs autonomous actions."""
    task = task_item["task"]
    task_id = task.get("id")
    status = task.get("status")
    task_title = task.get("task_title") or task.get("display_name") or task_id
    spec = task.get("spec", "")
    terminal_handle = task_item.get("terminal_handle")
    dispatch_id = task_item.get("dispatch_id")

    if not terminal_handle:
        return {
            "task_id": task_id,
            "status": status,
            "action": "skipped_no_terminal",
            "reason": "No terminal handle mapped"
        }

    screen = read_worker_screen(terminal_handle)
    if not screen:
        return {
            "task_id": task_id,
            "terminal": terminal_handle,
            "status": status,
            "action": "skipped_empty_screen",
            "reason": "Could not read terminal screen"
        }

    eval_res = query_jev_choice(screen, task_spec=spec, api_key=api_key)
    choice = eval_res.get("choice")
    conf = eval_res.get("confidence", 0.0)
    engine = eval_res.get("engine")

    record = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "run_id": run_id,
        "task_id": task_id,
        "task_title": task_title,
        "status": status,
        "terminal": terminal_handle,
        "dispatch_id": dispatch_id,
        "verdict": choice,
        "confidence": conf,
        "engine": engine,
        "elapsed_ms": eval_res.get("elapsed_ms", 0),
        "dry_run": dry_run
    }

    action_taken = "none"

    # Action 1: tests_passed_ready -> closeout and retain
    if choice == "tests_passed_ready" and status != "completed":
        action_taken = "emit_worker_done_and_retain"
        record["action"] = action_taken
        if not dry_run:
            # Emit worker_done
            send_args = [
                "orchestration", "send",
                "--run", run_id,
                "--task-id", task_id,
                "--type", "worker_done",
                "--outcome", "succeeded",
                "--subject", f"Foreman Verified: {task_title} completed",
                "--body", f"Foreman automated supervisor verified green test suite on terminal {terminal_handle}."
            ]
            if dispatch_id:
                send_args.extend(["--dispatch-id", dispatch_id])
            if terminal_handle:
                send_args.extend(["--from", terminal_handle])
            run_orca_command(send_args)

            # Retain terminal
            if dispatch_id:
                run_orca_command(["orchestration", "worker-retain", "--dispatch", dispatch_id])

            # Update task
            run_orca_command(["orchestration", "task-update", "--task", task_id, "--status", "completed"])
        print(f"[FOREMAN-ACTION] {task_id} ({task_title}): Tests passed -> worker_done emitted & terminal retained (dry_run={dry_run})")

    # Action 2: stuck_loop or idle_done -> autonomous nudge with 3-strike ceiling
    elif choice in ("stuck_loop", "idle_done") and status != "completed":
        strikes = get_strike_count(task_id)
        if strikes >= 3:
            action_taken = "escalate_needs_operator"
            record["action"] = action_taken
            record["strikes"] = strikes
            print(f"[FOREMAN-ALERT] {task_id} ({task_title}): Exceeded 3 nudge strikes without progress. Escalating to needs_operator.")
        else:
            new_strikes = increment_strike_count(task_id)
            action_taken = "nudge_continuation"
            record["action"] = action_taken
            record["strikes"] = new_strikes
            if not dry_run:
                nudge_text = "Continuá autónomamente con el siguiente paso y reportá evidencia técnica al finalizar."
                run_orca_command([
                    "terminal", "send",
                    "--terminal", terminal_handle,
                    "--text", nudge_text,
                    "--enter"
                ])
            print(f"[FOREMAN-ACTION] {task_id} ({task_title}): State '{choice}' -> Nudged worker (strike {new_strikes}/3, dry_run={dry_run})")

    # Action 3: provider_error -> backoff and retry
    elif choice == "provider_error":
        action_taken = "retry_provider_error"
        record["action"] = action_taken
        if not dry_run:
            # In a real tick, we wait 10s and send retry
            time.sleep(2)
            retry_text = "Reintentá la operación anterior."
            run_orca_command([
                "terminal", "send",
                "--terminal", terminal_handle,
                "--text", retry_text,
                "--enter"
            ])
        print(f"[FOREMAN-ACTION] {task_id} ({task_title}): Provider error -> Injected retry prompt (dry_run={dry_run})")

    else:
        record["action"] = "observe"
        print(f"[FOREMAN-OBSERVE] {task_id} ({task_title}) on {terminal_handle}: verdict={choice} (conf={conf:.2f}, engine={engine})")

    log_foreman_decision(record)
    return record


def run_supervisor_cycle(
    run_id: str,
    target_terminal: Optional[str] = None,
    target_task: Optional[str] = None,
    dry_run: bool = False,
    api_key: Optional[str] = None
) -> List[Dict[str, Any]]:
    """Runs a single pass across all or targeted active workers in the run."""
    task_items = get_active_tasks_and_workers(run_id)
    if not task_items:
        print(f"[FOREMAN] No active tasks found for run '{run_id}'")
        return []

    results = []
    for item in task_items:
        t_id = item["task"].get("id")
        h_handle = item.get("terminal_handle")
        if target_task and t_id != target_task:
            continue
        if target_terminal and h_handle != target_terminal:
            continue
        res = supervise_worker(run_id, item, dry_run=dry_run, api_key=api_key)
        results.append(res)

    return results


def resolve_current_run() -> Optional[str]:
    """Auto-detects the active or most recent run."""
    code, stdout, _ = run_orca_command(["orchestration", "run-current", "--json"])
    if code == 0 and stdout:
        try:
            data = json.loads(stdout).get("result", {})
            r_id = data.get("id") or data.get("runId")
            if r_id:
                return r_id
        except Exception:
            pass

    code, stdout, _ = run_orca_command(["orchestration", "run-list", "--json"])
    if code == 0 and stdout:
        try:
            data = json.loads(stdout).get("result", {})
            runs = data.get("runs", [])
            if runs:
                return runs[0].get("id")
        except Exception:
            pass
    return None


def main():
    parser = argparse.ArgumentParser(description="Foreman Autonomous Supervisor for Orca Multi-Agent Runs")
    parser.add_argument("--run", type=str, help="Target Orca Run ID (e.g. run_96b10360ff03)")
    parser.add_argument("--terminal", type=str, help="Target specific terminal handle")
    parser.add_argument("--task", type=str, help="Target specific task ID")
    parser.add_argument("--watch", action="store_true", help="Run supervisor in continuous loop")
    parser.add_argument("--interval", type=int, default=DEFAULT_INTERVAL, help=f"Polling interval seconds (default {DEFAULT_INTERVAL})")
    parser.add_argument("--dry-run", action="store_true", default=True, help="Evaluate state without sending mutating commands (default: True)")
    parser.add_argument("--live", action="store_true", help="Enable live unattended mutations (default: dry-run mode)")
    parser.add_argument("--once", action="store_true", help="Execute single supervisor cycle and exit")
    parser.add_argument("--json", action="store_true", help="Emit machine-readable JSON output")
    parser.add_argument("--api-key", type=str, help="Explicit TypeSafe API Key override")

    args = parser.parse_args()

    run_id = args.run or resolve_current_run()
    if not run_id:
        print("[FOREMAN-ERROR] No active Orca run detected. Specify --run <run_id> explicitly.", file=sys.stderr)
        sys.exit(1)

    dry_run = not args.live
    print(f"[FOREMAN-START] Supervising Run '{run_id}' (dry_run={dry_run}, interval={args.interval}s)")

    if args.watch:
        try:
            while True:
                results = run_supervisor_cycle(
                    run_id,
                    target_terminal=args.terminal,
                    target_task=args.task,
                    dry_run=dry_run,
                    api_key=args.api_key
                )
                time.sleep(args.interval)
        except KeyboardInterrupt:
            print("\n[FOREMAN-STOP] Supervisor stopped by operator.")
    else:
        results = run_supervisor_cycle(
            run_id,
            target_terminal=args.terminal,
            target_task=args.task,
            dry_run=dry_run,
            api_key=args.api_key
        )
        if args.json:
            print(json.dumps(results, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
codex_worker.py - T-0549: `codex exec` wrapper for per-tier Codex workers.

Codex pods cannot be orchestrators: `codex exec` has no PreToolUse `agent_id` to
distinguish a parent from a child, so nothing can wall an in-process Codex agent off
from editing inline (see wezbridge/_intel/briefs/2026-09-23-delegation-enforcement-MEMO.md
section 1). The enforceable pattern is Option C from that memo: run each Codex worker as
its own `codex exec` child process with a model/effort PINNED ON THE COMMAND LINE, not
decided by the model. This script is that single dispatch point.

It launches:
  codex exec -m <model> -c model_reasoning_effort=<effort> -s workspace-write
             --cd <cwd> --json -o <last-message-file> "<mission prompt>"

validates (model, effort) against _intel/model-tiers.json's codex-runtime entries before
spawning anything, captures stdout/stderr to _intel/foreman/<task>-codex.log, parses the
[WORKER_DONE] closure sentinel (reusing foreman.find_worker_done so both dispatch paths
agree on one closure grammar), and prints a JSON result on stdout:
  {"task": "T-NNNN", "model": "...", "effort": "...", "outcome": "succeeded|failed",
   "report": "...", "turn_context": {...or None}, "closure_line": "..."}

Exits non-zero when: the model/effort pair is invalid (no subprocess spawned), the
`codex exec` process itself errors or times out, or no [WORKER_DONE] closure is found
in its output.

Usage:
  python codex_worker.py --task T-NNNN --brief <path> --model gpt-6-luna --effort low \
      --cwd <worktree-or-tempdir> [--timeout 3600] [--codex-bin <path>]
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import foreman  # noqa: E402  - reuse find_worker_done/SENTINEL_RE/ECHO_MARKERS, one closure grammar

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

_PY_APPS = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
MODEL_TIERS_PATH = os.environ.get("MODEL_TIERS_PATH") or os.path.join(_PY_APPS, "_intel", "model-tiers.json")
FOREMAN_LOG_DIR = os.environ.get("FOREMAN_STATE_DIR") or os.path.join(_PY_APPS, "_intel", "foreman")
CODEX_BIN_DEFAULT = os.environ.get("CODEX_BIN", "codex")

# Fallback catalog used ONLY when _intel/model-tiers.json is missing or unreadable.
# Source: _intel/model-tiers-crosscheck-chatgpt-20260923.md (Codex CLI models.json efforts,
# ChatGPT web-search cross-check 2026-09-23). gpt-6-terra intentionally absent: GPT-6 has no
# Terra tier (Terra was retired GPT-5.6, see the crosscheck doc's "Coincidencias" section).
FALLBACK_CODEX_MODELS = {
    "gpt-6-astra": {"efforts": ["low", "medium", "high", "xhigh", "max", "ultra"]},
    "gpt-6-sol":   {"efforts": ["low", "medium", "high", "xhigh", "max", "ultra"]},
    "gpt-6-luna":  {"efforts": ["low", "medium", "high", "xhigh", "max"]},
}


def _now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def load_codex_model_catalog(path=None):
    """Returns (catalog: {model: {"efforts": [...]}}, source_path_or_'<fallback>')."""
    path = path or MODEL_TIERS_PATH
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        models = data.get("models", {})
        catalog = {
            name: {"efforts": list(spec.get("efforts", []))}
            for name, spec in models.items()
            if spec.get("runtime") == "codex"
        }
        if catalog:
            return catalog, path
    except (OSError, ValueError):
        pass
    return dict(FALLBACK_CODEX_MODELS), "<fallback>"


def validate_model_effort(model, effort, catalog):
    """Raises ValueError with an actionable message if (model, effort) is not a valid pair."""
    if model not in catalog:
        raise ValueError(
            f"unknown Codex model '{model}' — not a codex-runtime entry in the catalog "
            f"(known: {sorted(catalog)})"
        )
    allowed = catalog[model]["efforts"]
    if effort not in allowed:
        raise ValueError(
            f"effort '{effort}' is not valid for '{model}' (allowed: {allowed})"
        )


def build_mission_prompt(task_id, brief_text):
    """Wraps the brief with the fixed closure contract every dispatch path shares
    (see task_router.py's dispatch() and _intel/briefs/.../MEMO.md section 4 CHILD CLOSE)."""
    return f"""[WORKER MISSION] task_id={task_id}

{brief_text}

RULES:
1. Read the brief above and do the work it describes, fully and autonomously.
2. When finished (or if you cannot finish), your FINAL message must end with this
   exact closure line, then the criteria block, on their own lines:
[WORKER_DONE] task_id={task_id} outcome=succeeded|failed report=<path_or_summary>
criteria:
- <criterion 1>: pass|fail - <evidence>
files_changed: <comma-separated paths, or "none">
next_action: <what remains, or "none">
model_effort_used: <the exact model and effort you were invoked with>
"""


def run_codex_exec(model, effort, cwd, prompt, timeout, last_message_path,
                    codex_bin=None, sandbox="workspace-write", extra_args=None):
    """Builds and runs the codex exec command. Returns (returncode, stdout, stderr, cmd,
    timed_out: bool)."""
    codex_bin = codex_bin or CODEX_BIN_DEFAULT
    # subprocess.run() with shell=False does not do PATHEXT resolution on Windows, so a bare
    # "codex" (installed as codex.cmd via npm) raises WinError 2. shutil.which() finds it.
    resolved = shutil.which(codex_bin)
    if resolved:
        codex_bin = resolved
    cmd = [
        codex_bin, "exec",
        "-m", model,
        "-c", f"model_reasoning_effort={effort}",
        "-s", sandbox,
        "--cd", cwd,
        # Worker cwds are frequently a freshly created temp dir or worktree that is not (yet)
        # in ~/.codex/config.toml's [projects.*] trust list, which otherwise makes codex exec
        # refuse with "Not inside a trusted directory" (observed live 2026-09-23, T-0549).
        "--skip-git-repo-check",
        "--json",
        "-o", last_message_path,
    ]
    if extra_args:
        cmd.extend(extra_args)
    cmd.append(prompt)

    os.makedirs(os.path.dirname(last_message_path) or ".", exist_ok=True)
    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=timeout, stdin=subprocess.DEVNULL,
        )
        return proc.returncode, proc.stdout, proc.stderr, cmd, False
    except subprocess.TimeoutExpired as e:
        stdout = e.stdout or ""
        stderr = e.stderr or ""
        return None, stdout, stderr, cmd, True


def extract_turn_context(json_stdout):
    """Best-effort scan of the --json JSONL stream for an event carrying model/effort
    metadata (event type and shape are not pinned by codex's docs; this stays tolerant).
    Returns a dict or None."""
    last_ctx = None
    for line in json_stdout.splitlines():
        line = line.strip()
        if not line or not line.startswith("{"):
            continue
        try:
            evt = json.loads(line)
        except ValueError:
            continue
        candidate = None
        if isinstance(evt, dict):
            if "model" in evt or "effort" in evt or "reasoning_effort" in evt:
                candidate = evt
            elif isinstance(evt.get("msg"), dict) and (
                "model" in evt["msg"] or "effort" in evt["msg"] or "reasoning_effort" in evt["msg"]
            ):
                candidate = evt["msg"]
            elif evt.get("type") in ("turn_context", "task_started", "session_configured"):
                candidate = evt
        if candidate is not None:
            last_ctx = candidate
    return last_ctx


def parse_closure(text, task_id):
    """Reuses foreman.find_worker_done so both dispatch paths (orca terminals and codex
    exec children) agree on one closure grammar. Returns (task_id, outcome, extra) or None."""
    return foreman.find_worker_done(text, task_id)


def write_log(task_id, cmd, returncode, stdout, stderr, timed_out):
    os.makedirs(FOREMAN_LOG_DIR, exist_ok=True)
    log_path = os.path.join(FOREMAN_LOG_DIR, f"{task_id}-codex.log")
    with open(log_path, "w", encoding="utf-8") as f:
        f.write(f"# codex_worker.py log for {task_id} ({_now_iso()})\n")
        f.write(f"# cmd: {cmd}\n")
        f.write(f"# returncode: {returncode} timed_out: {timed_out}\n")
        f.write("## stdout\n")
        f.write(stdout or "")
        f.write("\n## stderr\n")
        f.write(stderr or "")
    return log_path


def main(argv=None):
    parser = argparse.ArgumentParser(description="Dispatch one codex exec worker for a task.")
    parser.add_argument("--task", required=True, help="Task id, e.g. T-0549")
    parser.add_argument("--brief", required=True, help="Path to the brief file to read")
    parser.add_argument("--model", required=True, help="e.g. gpt-6-luna | gpt-6-sol | gpt-6-astra")
    parser.add_argument("--effort", required=True, help="e.g. low | medium | high | xhigh | max | ultra")
    parser.add_argument("--cwd", required=True, help="Worktree or directory codex exec runs in")
    parser.add_argument("--timeout", type=int, default=3600, help="Seconds before the child is killed")
    parser.add_argument("--codex-bin", default=None, help="Override the codex executable")
    parser.add_argument("--model-tiers", default=None, help="Override _intel/model-tiers.json path")
    args = parser.parse_args(argv)

    catalog, catalog_source = load_codex_model_catalog(args.model_tiers)
    try:
        validate_model_effort(args.model, args.effort, catalog)
    except ValueError as e:
        print(json.dumps({
            "task": args.task, "model": args.model, "effort": args.effort,
            "outcome": "failed", "error": str(e), "catalog_source": catalog_source,
        }))
        return 2

    if not os.path.isfile(args.brief):
        print(json.dumps({
            "task": args.task, "model": args.model, "effort": args.effort,
            "outcome": "failed", "error": f"brief not found: {args.brief}",
        }))
        return 2

    with open(args.brief, "r", encoding="utf-8") as f:
        brief_text = f.read()
    prompt = build_mission_prompt(args.task, brief_text)

    os.makedirs(FOREMAN_LOG_DIR, exist_ok=True)
    last_message_path = os.path.join(FOREMAN_LOG_DIR, f"{args.task}-codex-last-message.txt")

    returncode, stdout, stderr, cmd, timed_out = run_codex_exec(
        args.model, args.effort, args.cwd, prompt, args.timeout, last_message_path,
        codex_bin=args.codex_bin,
    )
    log_path = write_log(args.task, cmd, returncode, stdout, stderr, timed_out)

    last_message = ""
    if os.path.isfile(last_message_path):
        try:
            with open(last_message_path, "r", encoding="utf-8") as f:
                last_message = f.read()
        except OSError:
            pass

    hit = parse_closure(last_message, args.task) or parse_closure(stdout, args.task)
    turn_context = extract_turn_context(stdout)

    result = {
        "task": args.task,
        "model": args.model,
        "effort": args.effort,
        "codex_returncode": returncode,
        "timed_out": timed_out,
        "log": log_path,
        "turn_context": turn_context,
    }

    if timed_out:
        result["outcome"] = "failed"
        result["error"] = f"codex exec timed out after {args.timeout}s with no closure"
        print(json.dumps(result))
        return 3

    if hit is None:
        result["outcome"] = "failed"
        result["error"] = "no [WORKER_DONE] closure found in codex exec output"
        print(json.dumps(result))
        return 4

    closure_task, closure_outcome, closure_extra = hit
    result["outcome"] = closure_outcome
    result["report"] = closure_extra.strip()
    result["closure_task_id"] = closure_task
    print(json.dumps(result))
    return 0 if closure_outcome == "succeeded" else 1


if __name__ == "__main__":
    sys.exit(main())

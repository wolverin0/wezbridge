import sys
import json
import os
import datetime

LOG_FILE = "G:/_OneDrive/OneDrive/Desktop/Py Apps/wezbridge/orchestrator_guard.log"

WORKER_PATTERNS = [
    "whatsappbot",
    "pedrito",
    "yolo26",
    "argentina-sales-hub",
    "crm",
    "_worktrees/bot-rf-optimizer"
]

def log_event(event_type, details):
    try:
        os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)
        timestamp = datetime.datetime.now().isoformat()
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(f"[{timestamp}] [{event_type}] {json.dumps(details, ensure_ascii=False)}\n")
    except Exception:
        pass

def main():
    try:
        raw_input = sys.stdin.read()
        if not raw_input:
            log_event("EMPTY_INPUT", {})
            print(json.dumps({"decision": "allow"}))
            return

        payload = json.loads(raw_input)
        log_event("HOOK_INVOKED", payload)
        tool_call = payload.get("toolCall", {})
        tool_name = tool_call.get("name", "")
        args = tool_call.get("args", {})
        workspaces = [w.replace("\\", "/").lower() for w in payload.get("workspacePaths", [])]

        # Check if current session is Orchestrator (wezbridge or infra)
        is_orchestrator = any("wezbridge" in w or "infra" in w for w in workspaces)

        # If not orchestrator, allow worker to edit their own files
        if not is_orchestrator:
            print(json.dumps({"decision": "allow"}))
            return

        # 1. Check file modifications
        if tool_name in ["write_to_file", "replace_file_content"]:
            target_file = (args.get("TargetFile") or "").replace("\\", "/").lower()
            for pattern in WORKER_PATTERNS:
                if pattern in target_file:
                    reason = (
                        f"🛑 ORCHESTRATOR ENFORCEMENT: Direct modification of worker project ({pattern}) "
                        f"is physically blocked. You are the Orchestrator. You MUST delegate this work to "
                        f"the corresponding worker pane in Orca using 'python scripts/orchestration/task_router.py' "
                        f"or 'orca terminal send'."
                    )
                    log_event("BLOCKED_FILE_WRITE", {"tool": tool_name, "target": target_file, "pattern": pattern})
                    print(json.dumps({"decision": "deny", "reason": reason}))
                    return

        # 2. Check run_command Cwd and CommandLine
        if tool_name == "run_command":
            cwd = (args.get("Cwd") or "").replace("\\", "/").lower()
            cmd = (args.get("CommandLine") or "").lower()

            for pattern in WORKER_PATTERNS:
                if pattern in cwd:
                    reason = (
                        f"🛑 ORCHESTRATOR ENFORCEMENT: Running commands inside worker directory ({pattern}) "
                        f"is physically blocked. You MUST dispatch this task to the worker pane in Orca."
                    )
                    log_event("BLOCKED_COMMAND_CWD", {"tool": tool_name, "cwd": cwd, "cmd": cmd, "pattern": pattern})
                    print(json.dumps({"decision": "deny", "reason": reason}))
                    return

        print(json.dumps({"decision": "allow"}))

    except Exception as e:
        log_event("ERROR", {"error": str(e)})
        # Fail safe
        print(json.dumps({"decision": "allow"}))

if __name__ == "__main__":
    main()

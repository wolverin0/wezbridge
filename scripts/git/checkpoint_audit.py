#!/usr/bin/env python3
"""
checkpoint_audit.py — Incremental Git Checkpoint Auditor.

Solves audit fatigue by auditing ONLY the diff between the last recorded checkpoint
and the current HEAD revision.

Usage:
  python scripts/git/checkpoint_audit.py [--repo <path>] [--reset] [--dry-run] [--json]
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

DEFAULT_CHECKPOINT_FILE = Path("_intel/audit-checkpoint.json")

DANGEROUS_PATTERNS = [
    (r"(?i)(?:api[_-]?key|secret[_-]?token|private[_-]?key)\s*[:=]\s*['\"][A-Za-z0-9_\-\.]{16,}['\"]", "Exposed API key / secret token"),
    (r"(?i)\bDROP\s+TABLE\b", "Destructive SQL: DROP TABLE"),
    (r"(?i)\bTRUNCATE\s+TABLE\b", "Destructive SQL: TRUNCATE TABLE"),
    (r"(?i)\bDELETE\s+FROM\s+\w+\s*(?:;|$)", "Unbounded SQL DELETE without WHERE"),
    (r"(?i)radio\.1\.(?:ch_width|chanbw)\s*=\s*(?!20\b)\d+", "Dangerous airOS channel width modification away from 20MHz"),
    (r"(?i)pfifo-limit\s*=\s*(?:[1-4]?[0-9])\b", "MikroTik Core buffer regression: pfifo-limit < 50"),
    (r"(?i)\bdryRun\s*:\s*false\b", "Dangerous automation: explicit dryRun: false uncoordinated"),
]

FRONTEND_EXTENSIONS = {".tsx", ".jsx", ".vue", ".html", ".css", ".scss", ".tailwind"}


def run_git(args: list[str], cwd: Path) -> str:
    res = subprocess.run(["git"] + args, cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace", check=False)
    if res.returncode != 0:
        raise RuntimeError(f"Git command failed: git {' '.join(args)}\n{res.stderr}")
    return (res.stdout or "").strip()


def load_checkpoint(checkpoint_path: Path) -> dict:
    if checkpoint_path.exists():
        try:
            with open(checkpoint_path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {"last_audited_commit": None, "updated_at": None}


def save_checkpoint(checkpoint_path: Path, data: dict):
    checkpoint_path.parent.mkdir(parents=True, exist_ok=True)
    with open(checkpoint_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)


def run_incremental_audit(repo_dir: Path, dry_run: bool = False, reset: bool = False) -> dict:
    checkpoint_file = repo_dir / DEFAULT_CHECKPOINT_FILE
    head_sha = run_git(["rev-parse", "HEAD"], cwd=repo_dir)

    if reset:
        save_checkpoint(checkpoint_file, {"last_audited_commit": head_sha, "updated_at": datetime.now(timezone.utc).isoformat()})
        return {"status": "reset", "head": head_sha, "message": "Checkpoint reset to current HEAD."}

    checkpoint = load_checkpoint(checkpoint_file)
    last_sha = checkpoint.get("last_audited_commit")

    if not last_sha:
        # First run: set baseline to HEAD~1 or HEAD
        try:
            last_sha = run_git(["rev-parse", "HEAD~1"], cwd=repo_dir)
        except RuntimeError:
            last_sha = head_sha

    if last_sha == head_sha:
        return {
            "status": "clean",
            "commits_checked": 0,
            "last_audited_commit": last_sha,
            "head": head_sha,
            "violations": [],
            "frontend_changed": False,
            "message": "No new commits since last audit checkpoint. (0ms overhead)",
        }

    # Fetch changed files
    diff_files_raw = run_git(["diff", f"{last_sha}..{head_sha}", "--name-only"], cwd=repo_dir)
    changed_files = [f.strip() for f in diff_files_raw.splitlines() if f.strip()]

    # Fetch full diff for safety patterns
    diff_patch = run_git(["diff", f"{last_sha}..{head_sha}"], cwd=repo_dir)

    violations = []
    for pattern, reason in DANGEROUS_PATTERNS:
        matches = re.findall(pattern, diff_patch)
        if matches:
            violations.append({"reason": reason, "count": len(matches), "pattern": pattern})

    frontend_changed = any(Path(f).suffix.lower() in FRONTEND_EXTENSIONS for f in changed_files)

    result = {
        "status": "failed" if violations else "passed",
        "last_audited_commit": last_sha,
        "head": head_sha,
        "changed_files_count": len(changed_files),
        "changed_files": changed_files[:25],
        "frontend_changed": frontend_changed,
        "violations": violations,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }

    if not dry_run and not violations:
        save_checkpoint(checkpoint_file, {"last_audited_commit": head_sha, "updated_at": datetime.now(timezone.utc).isoformat()})

    return result


def main():
    parser = argparse.ArgumentParser(description="Incremental Git Checkpoint Auditor")
    parser.add_argument("--repo", type=str, default=".", help="Path to Git repository")
    parser.add_argument("--reset", action="store_true", help="Reset checkpoint to current HEAD")
    parser.add_argument("--dry-run", action="store_true", help="Do not update checkpoint file")
    parser.add_argument("--json", action="store_true", help="Emit JSON output")
    args = parser.parse_args()

    repo_path = Path(args.repo).resolve()
    res = run_incremental_audit(repo_path, dry_run=args.dry_run, reset=args.reset)

    if args.json:
        print(json.dumps(res, indent=2))
    else:
        print("=" * 60)
        print(f"  INCREMENTAL CHECKPOINT AUDIT ({repo_path.name})")
        print("=" * 60)
        print(f"• Estado                : {res.get('status', 'unknown').upper()}")
        print(f"• Checkpoint anterior   : {res.get('last_audited_commit', 'None')[:10]}")
        print(f"• HEAD actual           : {res.get('head', 'None')[:10]}")
        print(f"• Archivos modificados  : {res.get('changed_files_count', 0)}")
        print(f"• Impacto Frontend (UI) : {'SI (Recomendado UI Battle Test)' if res.get('frontend_changed') else 'NO'}")
        if res.get("violations"):
            print("\n❌ VIOLACIONES DETECTADAS:")
            for v in res["violations"]:
                print(f"  - {v['reason']} (x{v['count']})")
        else:
            print("\n✅ Sin violaciones de seguridad detectadas en el diff.")
        print("=" * 60)

    if res.get("status") == "failed":
        sys.exit(1)


if __name__ == "__main__":
    main()

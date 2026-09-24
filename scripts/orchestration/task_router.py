#!/usr/bin/env python3
"""
Task Router & Dispatcher for Orca Orchestrator

Routes incoming technical requests to the appropriate worker, constructs a structured
mission brief with acceptance criteria and a completion sentinel, dispatches it through
bin/a2a-send-cli.cjs (the a2a_send control plane), and registers the task in the database.

T-0596 paso 2: this file no longer resolves or hardcodes any terminal handle (WezTerm
pane id or Orca handle) itself. Every dispatch names a PROJECT — a2a-send-cli.cjs
(bin/a2a-send-cli.cjs -> src/mcp-server.cjs's a2a_send) resolves that project to a live
WezTerm pane or Orca terminal AT SEND TIME, via the same resolver queue-drain uses
(src/pane-identity.cjs + src/orca-target.cjs), and durably queues it when nothing is
live. The old WORKER_REGISTRY `default_term_id`s were stale handles from a machine
that no longer has them; a project name never goes stale the way a handle does.
"""

import sys
import os
import json
import subprocess
import time
import argparse
import re
import shlex

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8")

_REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
A2A_SEND_CLI = os.environ.get("A2A_SEND_CLI") or os.path.join(_REPO, "bin", "a2a-send-cli.cjs")
NODE_BIN = os.environ.get("WEZBRIDGE_NODE_BIN") or "node"

# project_pattern is the PROJECT NAME a2a-send-cli.cjs resolves at send time (WezTerm
# pane or Orca terminal, whichever is live) — never a terminal id. Kept only for
# classify_intent's keyword routing (the deprecated --domain/--title/--prompt path).
WORKER_REGISTRY = {
    "wabot": {
        "name": "WhatsApp Bot Worker",
        "project_pattern": "whatsappbot",
        "description": "WhatsApp Bot backend, stages, services, tests, UCRM/Evolution integrations",
        "test_cmd": "npm test"
    },
    "wisp_rf": {
        "name": "WISP RF Optimizer Worker",
        "project_pattern": "bot-rf-optimizer",
        "description": "RF tower analysis, Ubiquiti airMAX/LTU, spectrum audits, dispatches, MikroTik queues",
        "test_cmd": "python -m unittest"
    },
    "pedrito": {
        "name": "Pedrito AFIP / Facturación Worker",
        "project_pattern": "pedrito",
        "description": "AFIP billing, receipt generation, ARCA scraping",
        "test_cmd": "npm test"
    },
    "yolo26": {
        "name": "YOLO26 Sales Worker",
        "project_pattern": "yolo26",
        "description": "Leads, sales automation, CRM prospecting",
        "test_cmd": "npm test"
    },
    "sales_hub": {
        "name": "Argentina Sales Hub Worker",
        "project_pattern": "argentina-sales-hub",
        "description": "Sales hub dashboard and pipeline tracking",
        "test_cmd": "npm test"
    }
}

def classify_intent(text):
    """
    DEPRECATED (T-0548): keyword routing is kept only for backward compatibility with
    `--domain/--title/--prompt`. New dispatches use `--from-card T-NNNN`, where the card's
    runtime/model/effort/tier (validated by ledger.cjs against _intel/model-tiers.json)
    decide the call instead of keywords.

    Classifies a natural language prompt or event into a target domain.
    """
    t = text.lower()

    if any(k in t for k in ["torre", "antena", "frecuencia", "rf", "airmax", "ltu", "sector", "mikrotik", "queue", "despacho", "oscar", "ruben", "cpe", "winback", "potencia", "ruido", "snr", "ptp"]):
        return "wisp_rf"
    
    if any(k in t for k in ["bot", "stage", "whatsapp", "mensaje", "upsell", "reclamo", "diagnostico", "chatwoot", "evolution", "promocion", "flow", "survey"]):
        return "wabot"
    
    if any(k in t for k in ["afip", "factura", "arca", "pedrito", "comprobante"]):
        return "pedrito"
    
    if any(k in t for k in ["yolo", "lead", "prospecto"]):
        return "yolo26"

    if any(k in t for k in ["sales", "hub"]):
        return "sales_hub"

    # Default fallback to wabot if bot-related or unspecified
    return "wabot"

def dispatch(domain, title, description, criteria=None):
    """Constructs the structured prompt and sends it via a2a-send-cli.cjs to the
    project's live pane/terminal (resolved AT SEND TIME, not here)."""
    if domain not in WORKER_REGISTRY:
        domain = classify_intent(f"{title} {description}")

    worker_info = WORKER_REGISTRY[domain]
    project = worker_info["project_pattern"]
    task_id = f"task_{int(time.time())}_{domain}"

    criteria_str = "\n".join([f"- {c}" for c in (criteria or ["Verificar que todos los tests pasen.", "Dejar evidencia reproducible."])])

    dispatch_prompt = f"""[MISIÓN DELEGADA POR ORCHESTRATOR]
ID: {task_id}
TÍTULO: {title}
OBJETIVO:
{description}

CRITERIOS DE ACEPTACIÓN:
{criteria_str}

REGLAS DE EJECUCIÓN:
1. Ejecutá la implementación de forma completamente autónoma en tu worktree.
2. Ejecutá la suite de tests ({worker_info['test_cmd']}) para validar regresiones.
3. Al terminar, emití en esta terminal el marcador obligatorio de cierre:
[WORKER_DONE] task_id={task_id} outcome=succeeded report=<ruta_del_reporte_o_resumen>
"""

    print(f"[*] Enrutando tarea a '{worker_info['name']}' (proyecto: {project})")
    print(f"[*] Task ID: {task_id}")

    # T-0596 paso 2: through a2a-send-cli.cjs (the a2a_send control plane), never a raw
    # `orca terminal send` — it resolves the project to a live WezTerm pane or Orca
    # terminal at send time and durably queues when nothing is live.
    send_cmd = [NODE_BIN, A2A_SEND_CLI, "--to-project", project, "--type", "request", "--body", dispatch_prompt]
    res = subprocess.run(send_cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")

    if res.returncode == 0:
        print(f"[+] Tarea inyectada con éxito en '{project}'.")
        return {"success": True, "task_id": task_id, "project": project, "domain": domain}
    else:
        print(f"[-] Error enviando tarea: {(res.stdout or '') + (res.stderr or '')}")
        return {"success": False, "error": (res.stdout or "") + (res.stderr or "")}

# ---------------------------------------------------------------- --from-card (T-0548)
# The card is the source of the dispatch: ledger.cjs already validated runtime/model/effort
# against _intel/model-tiers.json, so this only TRANSLATES the card into the exact call.
# It prints; it never launches anything.
_PY_APPS = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".."))
CARD_ID_RE = re.compile(r"^T-\d{4}$")
# Claude worker agents (~/.claude/agents/worker-tN.md). V = sonnet/high, same as worker-t3.
TIER_AGENT = {"T1": "worker-t1", "T2": "worker-t2", "T3": "worker-t3", "T4": "worker-t4", "V": "worker-t3"}


class CardError(Exception):
    pass


def intel_dir():
    return os.environ.get("WEZBRIDGE_INTEL_DIR") or os.path.join(_PY_APPS, "_intel")


def load_card(card_id, intel=None):
    if not CARD_ID_RE.match(card_id or ""):
        raise CardError(f"--from-card needs an id like T-0001, got {card_id!r}")
    path = os.path.join(intel or intel_dir(), "tasks", f"{card_id}.json")
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        raise CardError(f"{card_id}: no card at {path}")


def load_tiers(intel=None):
    path = os.path.join(intel or intel_dir(), "model-tiers.json")
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        raise CardError(f"{path} is missing; it maps model ids to aliases and tiers. Refusing to guess.")


def repo_path(repo):
    """Worktree for a card's repo: sweeper-config.json (root + path) when listed, else <Py Apps>/<repo>."""
    try:
        with open(os.path.join(_PY_APPS, "_docs-curation", "sweeper-config.json"), "r", encoding="utf-8") as f:
            cfg = json.load(f)
        for r in cfg.get("repos", []):
            if r.get("name") == repo:
                return os.path.join(cfg.get("root", _PY_APPS), r["path"]).replace("\\", "/")
    except (OSError, ValueError, KeyError):
        pass
    return os.path.join(_PY_APPS, repo or "").replace("\\", "/")


def build_card_prompt(card, brief=None):
    model, effort = card.get("model"), card.get("effort")
    criteria = card.get("acceptance_criteria") or []
    lines = [f"[MISION {card['id']}] {card.get('title', '')}", f"Repo: {card.get('repo')}", "", "Objetivo:", card.get("goal", "")]
    if brief:
        lines += ["", f"Lee primero el brief: {brief}"]
    if criteria:
        lines += ["", "Criterios de aceptacion:"] + [f"- {c}" for c in criteria]
    lines += [
        "",
        "Al cerrar, emiti un bloque criteria: con cada criterio `pass|fail — evidencia`, files_changed, next_action,",
        # Placeholder with '<' on purpose: this prompt echoes on the worker screen, and Foreman
        # ignores model_effort_used values containing '<' so the echo is never read as the answer.
        f"y la linea `model_effort_used: <modelo>/<effort>` con lo que realmente corriste (la tarjeta pide {model}/{effort or '-'}).",
        f"Marcador final: [WORKER_DONE] task_id={card['id']} outcome=succeeded report=RUTA_DEL_REPORTE",
    ]
    return "\n".join(lines)


def _alias(tiers, model):
    return ((tiers.get("models") or {}).get(model) or {}).get("alias")


def _agent_for(tiers, card):
    tier = card.get("tier")
    if tier in TIER_AGENT:
        return TIER_AGENT[tier]
    for t, agent in TIER_AGENT.items():  # no tier: match model+effort against the claude mappings
        spec = ((tiers.get("tiers") or {}).get(t) or {}).get("claude") or {}
        if spec.get("model") == card.get("model") and spec.get("effort") == card.get("effort"):
            return agent
    return None


def build_from_card(card, tiers, brief=None, worktree=None):
    """Pure translation card -> dispatch dict. Raises CardError on a card that cannot be dispatched."""
    runtime, model, effort = card.get("runtime"), card.get("model"), card.get("effort")
    if not runtime or not model:
        raise CardError(f"{card.get('id')}: card has no runtime/model; set it with "
                        f"`ledger.cjs update {card.get('id')} --tier T1..T5|V` (or --runtime/--model/--effort)")
    if model not in (tiers.get("models") or {}):
        raise CardError(f"{card.get('id')}: model {model!r} is not in model-tiers.json")
    prompt = build_card_prompt(card, brief)
    out = {"card": card["id"], "runtime": runtime, "model": model, "effort": effort, "tier": card.get("tier")}
    if runtime == "claude":
        alias = _alias(tiers, model)
        if not alias:
            raise CardError(f"{card['id']}: claude model {model!r} has no alias in model-tiers.json")
        agent = _agent_for(tiers, card)
        notes = []
        if not agent:
            agent = "general-purpose"
            notes.append(f"no worker-tN matches tier={card.get('tier')} {model}/{effort}; "
                         f"general-purpose cannot pin effort={effort}")
        out["agent_call"] = {"subagent_type": agent, "model": alias, "prompt": prompt}
        # T-0596 paso 2: no roster/legacy handle resolution here anymore — this only NAMES
        # the destination project (the card's repo). a2a-send-cli.cjs (bin/a2a-send-cli.cjs)
        # resolves that project to a live WezTerm pane or Orca terminal AT SEND TIME (the
        # SAME resolver a2a_send and queue-drain use: src/pane-identity.cjs's resolve() +
        # src/orca-target.cjs), and durably queues the dispatch when nothing is live —
        # never a stale terminal id baked in here.
        args = [NODE_BIN, A2A_SEND_CLI, "--to-project", card.get("repo") or "", "--type", "request",
                "--corr", card["id"], "--body", prompt]
        out["pane_command"] = " ".join(shlex.quote(a) for a in args)
        out["notes"] = notes
    elif runtime == "codex":
        if not effort:
            raise CardError(f"{card['id']}: codex card needs an effort (model_reasoning_effort)")
        wt = worktree or repo_path(card.get("repo"))
        args = ["codex", "exec", "-m", model, "-c", f"model_reasoning_effort={effort}",
                "-s", "workspace-write", "--cd", wt, prompt]
        out["codex_command"] = " ".join(shlex.quote(a) for a in args)
        out["codex_argv"] = args
    else:
        raise CardError(f"{card['id']}: unknown runtime {runtime!r} (claude|codex)")
    return out


def print_from_card(d):
    if d["runtime"] == "claude":
        print("# Agent tool call (subagent dispatch):")
        print(json.dumps(d["agent_call"], ensure_ascii=False))
        print("# Pane dispatch (a2a-send-cli):")
        print(d["pane_command"])
        for n in d.get("notes", []):
            sys.stderr.write(f"[task_router] note: {n}\n")
    else:
        print("# Codex worker:")
        print(d["codex_command"])


def main(argv=None):
    parser = argparse.ArgumentParser(description="Task Router & Dispatcher for Orca Orchestrator")
    parser.add_argument("--from-card", metavar="T-NNNN",
                        help="Print the exact dispatch command for a ledger card (Agent JSON / a2a-send-cli / codex exec)")
    parser.add_argument("--brief", help="With --from-card: brief path the worker must read first")
    parser.add_argument("--worktree", help="With --from-card (codex): --cd directory (default: the card repo path)")
    parser.add_argument("--domain", choices=list(WORKER_REGISTRY.keys()), help="[deprecated] Target worker domain")
    parser.add_argument("--title", help="[deprecated keyword path] Task title")
    parser.add_argument("--prompt", help="[deprecated keyword path] Task description / prompt")
    parser.add_argument("--criteria", nargs="*", help="List of acceptance criteria")

    args = parser.parse_args(argv)
    if args.from_card:
        try:
            d = build_from_card(load_card(args.from_card), load_tiers(), brief=args.brief,
                                worktree=args.worktree)
        except CardError as e:
            sys.stderr.write(f"task_router error: {e}\n")
            return 1
        print_from_card(d)
        return 0
    if not args.title or not args.prompt:
        parser.error("--title and --prompt are required (or use --from-card T-NNNN)")
    dispatch(args.domain, args.title, args.prompt, args.criteria)
    return 0

if __name__ == "__main__":
    sys.exit(main())

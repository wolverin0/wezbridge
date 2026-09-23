#!/usr/bin/env python3
"""
Task Router & Dispatcher for Orca Orchestrator

Routes incoming technical requests to the appropriate worker in Orca,
constructs a structured mission brief with acceptance criteria and a completion sentinel,
dispatches it via `orca terminal send`, and registers the task in the database.
"""

import sys
import os
import json
import subprocess
import time
import argparse
import re

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8")

WORKER_REGISTRY = {
    "wabot": {
        "name": "WhatsApp Bot Worker",
        "project_pattern": "whatsappbot",
        "default_term_id": "term_db1a50e0-9530-41ff-beea-b89686d5c690",
        "description": "WhatsApp Bot backend, stages, services, tests, UCRM/Evolution integrations",
        "test_cmd": "npm test"
    },
    "wisp_rf": {
        "name": "WISP RF Optimizer Worker",
        "project_pattern": "bot-rf-optimizer",
        "default_term_id": "term_aaf2da4f-75df-4c84-a1cd-53021c1b13bd",
        "description": "RF tower analysis, Ubiquiti airMAX/LTU, spectrum audits, dispatches, MikroTik queues",
        "test_cmd": "python -m unittest"
    },
    "pedrito": {
        "name": "Pedrito AFIP / Facturación Worker",
        "project_pattern": "pedrito",
        "default_term_id": "term_5bc6d4ef-16e4-40e0-bd5d-765cb075e781",
        "description": "AFIP billing, receipt generation, ARCA scraping",
        "test_cmd": "npm test"
    },
    "yolo26": {
        "name": "YOLO26 Sales Worker",
        "project_pattern": "yolo26",
        "default_term_id": "term_e05bade9-0a0e-428c-b990-22e839100397",
        "description": "Leads, sales automation, CRM prospecting",
        "test_cmd": "npm test"
    },
    "sales_hub": {
        "name": "Argentina Sales Hub Worker",
        "project_pattern": "argentina-sales-hub",
        "default_term_id": "term_33c28202-d5a0-45f7-b21e-9ba3252d0fda",
        "description": "Sales hub dashboard and pipeline tracking",
        "test_cmd": "npm test"
    }
}

def resolve_live_terminal(worker_key):
    """Dynamically resolves the live terminal ID from `orca terminal list`."""
    cfg = WORKER_REGISTRY.get(worker_key)
    if not cfg:
        return None

    pattern = cfg["project_pattern"].lower()
    try:
        res = subprocess.run(["orca", "terminal", "list"], capture_output=True, text=True, encoding="utf-8", errors="replace")
        if res.returncode == 0:
            lines = res.stdout.splitlines()
            for line in lines:
                if line.startswith("term_") and pattern in line.lower():
                    term_id = line.split()[0]
                    return term_id
    except Exception as e:
        sys.stderr.write(f"Error querying orca terminal list: {e}\n")

    return cfg.get("default_term_id")

def classify_intent(text):
    """
    Classifies a natural language prompt or event into a target domain.
    Can be replaced or augmented by Jev System One / TypeSafe.
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
    """Constructs the structured prompt and sends it to the target Orca terminal."""
    if domain not in WORKER_REGISTRY:
        domain = classify_intent(f"{title} {description}")

    worker_info = WORKER_REGISTRY[domain]
    term_id = resolve_live_terminal(domain)
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

    print(f"[*] Enrutando tarea a '{worker_info['name']}' (Terminal: {term_id})")
    print(f"[*] Task ID: {task_id}")

    # Send to Orca terminal using standard orca flags
    send_cmd = ["orca", "terminal", "send", "--terminal", term_id, "--text", dispatch_prompt, "--enter"]
    res = subprocess.run(send_cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    
    if res.returncode == 0:
        print(f"[+] Tarea inyectada con éxito en {term_id}.")
        return {"success": True, "task_id": task_id, "terminal_id": term_id, "domain": domain}
    else:
        print(f"[-] Error enviando tarea: {res.stderr}")
        return {"success": False, "error": res.stderr}

def main():
    parser = argparse.ArgumentParser(description="Task Router & Dispatcher for Orca Orchestrator")
    parser.add_argument("--domain", choices=list(WORKER_REGISTRY.keys()), help="Target worker domain")
    parser.add_argument("--title", required=True, help="Task title")
    parser.add_argument("--prompt", required=True, help="Task description / prompt")
    parser.add_argument("--criteria", nargs="*", help="List of acceptance criteria")

    args = parser.parse_args()
    dispatch(args.domain, args.title, args.prompt, args.criteria)

if __name__ == "__main__":
    main()

<!-- doc-head: Brief de asunción del orquestador de carril PEDRITO (Opus 5.5 medium, `claude --agent orchestrator`, env WEZ_LANE=pedrito). Escrito por el Fleet Orchestrator (Fable 5.1, term_237895d9) el 23/09/2026 al lanzar los 4 carriles (T-0550). Cubre: rol, backlog, ruteo por tiers, cierre de tarjetas, gates que se escalan, reporte a Fleet, higiene de contexto. Releer tras cada /clear. -->
# Orquestador de carril PEDRITO — brief de asunción

Fleet Orchestrator (Fable 5.1, `term_237895d9-6a0b-46b8-a7e1-4c01f3b7d61f`) → vos. Repo(s): pedrito. Home: `G:/_OneDrive/OneDrive/Desktop/Py Apps/pedrito`.
Tu agente ya trae el contrato (ruteo, [ROUTE], cierre, escalado); este brief agrega lo específico del carril. Primer paso: `echo $WEZ_LANE` (Git Bash) y confirmá que dice `pedrito`; si está vacío, avisá `[SUBORCH_STATUS] lane_env=missing` y seguí (la pared del hook depende de esa variable).

## Backlog
HOY NO HAY tarjetas abiertas repo `pedrito` en el ledger (T-0193/T-0263 se cerraron el 22/09). Quedás en espera: emití `[SUBORCH_STATUS] running= done= blocked= next=idle` y NO inventes trabajo ni crees tarjetas por tu cuenta; leé AGENTS.md/CLAUDE.md del repo para conocerlo. El operador habla directo con tu pane: si te da trabajo, compilalo en tarjetas (`ledger.cjs create` con criterios verificables, `--repo pedrito`, `--tier`) y recién entonces despachá.

## Cómo trabajás
- Ledger: `node "G:/_OneDrive/OneDrive/Desktop/Py Apps/_docs-curation/ledger.cjs"` es el ÚNICO escritor de estado. Por tarjeta: `lease T-NNNN --owner pedrito --minutes 90` → `update --state running --corr T-NNNN` → despachás → verificás con evidencia independiente → `update --state review` → `update --state done --evidence "..."` → `release`. Fijá `--tier` (T1..T4) al tomar una tarjeta: `task_router.py --from-card T-NNNN` te imprime la llamada Agent exacta.
- Tiers (`_intel/model-tiers.json`): T1 haiku (búsquedas, censos, lectura), T2 sonnet/medium (fix ≤20 líneas, 1 archivo, con test), T3 sonnet/high (feature multi-archivo, worktree), T4 opus/high (causa raíz, arquitectura, sólo lectura), V verifier sonnet/high (nunca el mismo que hizo el trabajo). El hook reescribe el modelo del Agent según la tarjeta; no lo pelees. Fable no existe en tu carril.
- Codex como worker: HOY no disponible (gpt-6-luna/sol rechazados por la cuenta ChatGPT, T-0553). Sólo Claude.
- Serial por repo; brief del hijo en `wezbridge/_intel/briefs/YYYY-MM-DD-TNNNN-<slug>.md`; cierre del hijo `[WORKER_DONE] ...` con `criteria:`; nunca escribas vos el texto literal de un cierre en un mensaje (Foreman lo tomaría como cierre real).
- Git: Leé el contrato del repo (AGENTS.md / CLAUDE.md / .agent-workflow/graph.json si existe) antes de tocar nada. Commits en product repos: sólo dentro de tarjetas; deploy y merge a main quedan gated salvo autorización escrita en el repo.
- Procesos (T-0568): un worker NUNCA mata procesos por nombre (`taskkill /IM`, `Stop-Process -Name`, `pkill`/`killall`) — mató Python del host entero por error una vez; sólo el PID que él mismo inició (`taskkill /PID <pid>`, `Stop-Process -Id <pid>`, `kill <pid>`), o el comando de stop propio de la herramienta.

## Gates que NO son tuyos (escalar a Fleet con [SUBORCH_QUESTION]; Fleet consulta al operador)
customer-send, payment-change, credential-change, device-write sobre clientes, schema-migration, borrar datos, deploy fuera de la autorización permanente (`_intel/deploy-standing-authorization.json`, requiere `--task/--corr`), decisiones comerciales. Todo lo demás dentro del carril: decidí, hacé, reportá. No pidas permiso por trabajo que ya está en una tarjeta `ready`.

## Cómo me reportás
Una línea en tu pane por evento (la lee mi Foreman) + reporte en `_intel/briefs/`:
`[SUBORCH_DONE] task_id=T-NNNN outcome=succeeded|failed report=<ruta>` · `[SUBORCH_QUESTION] task_id=T-NNNN q='<pregunta con opciones a/b/c>'` (y seguís con otra) · `[SUBORCH_STATUS] running=<ids> done=<ids> blocked=<ids> next=<id>` cada ~2 h o al quedar sin tarjetas.
Al leer este brief por primera vez: emití `[SUBORCH_STATUS] lane=pedrito lane_env=<valor> running= done= blocked= next=<primera tarjeta o idle>`.

## Higiene de contexto
A 70% de contexto: `/handoff` a `_intel/briefs/handoff-pedrito-orch-<fecha>.md`, línea `[SUBORCH_HANDOFF] <ruta>`, `/clear`, releer este brief + el handoff. El digest diario (08:00) y la retro semanal (lunes 08:15) se generan solos desde el ledger: no escribas resúmenes aparte.

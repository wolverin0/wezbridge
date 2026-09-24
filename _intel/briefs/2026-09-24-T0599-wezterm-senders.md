# T-0599 — WezTerm senders that bypass Orca, routed via decision-relay/a2a

Brief + log del worker T3. Rama `fix/t0599-wezterm-senders-orca` desde `origin/main`
(head 7516718, PR #56 ya mergeado a main). Lee `docs/a2a-protocol.md`'s "Transport: Orca
vs. WezTerm" y `_intel/briefs/2026-09-24-T0596-items45.md` antes de tocar nada.

## Problema (verifier finding en PR #56)
`a2a_send` y el queue-drain ya entregan via Orca (T-0596 items 1-5). Pero varios senders
siguen llamando `sendPromptDeferredEnter`/`verifyPromptSubmission` directo contra un pane
id ya resuelto por WezTerm — con la flota entera viviendo en Orca, esos envios no llegan a
nadie, silenciosamente.

## AC1 — Inventario (file:line, que manda, a quien, como resuelve el target)

| Archivo:linea | Que manda | A quien | Como resuelve target | Clase |
|---|---|---|---|---|
| `src/decision-relay.cjs:353-380` (`attemptSend`) | El sobre `[decision] operator approved/cancelled ...` cuando el operador aprueba/cancela una tarjeta | El pane del repo dueño de la tarjeta (o `finalorchestra` si la lease es de Eve) | `pane-identity.cjs`'s `resolve()` contra un censo WezTerm inyectado (`discoverPanes`) — SIN pasar por a2a_send | (a) mensajeria de flota — DEBE ir por Orca |
| `src/orchestrator-waker.cjs` (usa `verified-send.cjs` inyectado como `send`) | Poke corto "turno de X repo terminó" | El pane-0 / orquestador | Censo del worker (`discoverPanes`), pane fijo (pane-0), sin resolver por proyecto | (a) mensajeria de flota, PERO identidad pane-0 es WezTerm-only por diseño — ver decisión abajo |
| `src/handlers/event-handlers.cjs:527-575` | Arma el waker con `send = daemon-cli.cjs's .verified` (WezTerm real, corre en un child del daemon) | — | — | wiring de (a), mismo sender que orchestrator-waker.cjs |
| `src/gmail-routine-dispatch.cjs:44-52` | El poke diario de gmail-recordatorios | El pane del proyecto `wezbridge` | `pane-identity.resolve('wezbridge', ...)` contra censo WezTerm | (a) mensajeria de flota, pero **NO TOCAR antes de 2026-09-26 08:30 ART** (T-0339, bajo observación real) — inventariado solamente |
| `src/mcp-server.cjs` (`a2a_send`, `to_project`) | — | — | Orca primero por default; WezTerm SOLO si `WEZBRIDGE_WEZTERM_TRANSPORT=1` | (b) ya arreglado en T-0596 item 4, sin tocar |
| `src/project-queue.cjs` (`findTarget`, queue-drain) | — | — | Orca primero por default; WezTerm SOLO si el flag | (b) ya arreglado en T-0596 item 4, sin tocar |
| `src/verified-send.cjs` | primitiva de bajo nivel (`sendPromptDeferredEnter`/`verifyPromptSubmission`/`composerHoldsForeignText`) | — | — | (b) primitiva WezTerm, la siguen usando el camino legado con flag y `send_prompt`/`send_key` (tools WezTerm-only, documentados como tal) |
| `src/daemon-cli.cjs` / `daemon-cli-worker.cjs` | plumbing: corre `wez.*`/`verified.*` en un child process disponible (aisla el thread del daemon) | — | no decide destinatarios, solo ejecuta lo que el llamador le pide | (b)/(c) — transporte generico, no una decisión de "a quién". Sin cambios |
| `src/poke-payload-ceiling.cjs` | nada — es un helper puro (`pokeCeilingWarning`) usado por `scripts/poke-pane.cjs`; el match de grep es un comentario que MENCIONA `wezterm cli send-text`, no una llamada | — | — | (c) dead/no-op para este inventario — no hay call site real aquí |
| `scripts/poke-pane.cjs` (no listado en el problema original, encontrado al revisar quién usa el ceiling) | comando manual de operador (`node scripts/poke-pane.cjs`) | pane explícito por id | pane id pasado a mano por el operador, no resuelto por proyecto | (b) herramienta manual WezTerm-only, análoga a `send_prompt` — fuera de alcance, no es "mensajeria de flota" automática |

"El daemon sentinel" del enunciado = `src/handlers/event-handlers.cjs`'s wiring del
orchestrator-waker (línea ~530: `const verifiedSend = require('../daemon-cli.cjs').verified;`).

## Decisión de diseño — por qué decision-relay NO llama literalmente a `a2a_send`

El brief pedía enrutar cada sender (a) por el *core* de `a2a_send` (in-process o
`bin/a2a-send-cli.cjs`) para que gate/shape/lease/queue/audit apliquen. Revisando
`mcp-server.cjs`'s handler de `a2a_send` (líneas 1515-1900+) encontré que:

1. `a2a_send` exige un `from_pane` entero real (vía `resolveSelfPane`) y aplica
   `checkDispatchGate` + `takeDispatchLease` (**toma lease sobre el corr**, con
   `owner: toProject`) — decision-relay lee `card.lease.owner` para decidir el ruteo a
   Eve (`eve:<jobId>`); si a2a_send sobre-escribe ese owner en cada relay, se pierde la
   señal que decision-relay necesita para las próximas pasadas sobre la MISMA tarjeta.
2. `a2a_send` hace su PROPIO `projectQueue.enqueue()` cuando no puede entregar en vivo
   (mismo archivo `_intel/queues/<project>.jsonl` que ya usa el `enqueue()` propio de
   decision-relay, con OTRO `entryId` — `from_pane` distinto). Encolar por los dos
   caminos duplicaría la entrega cuando `queue-drain` reprocese: exactamente la clase de
   bug (T-0362, doble entrega) que este mismo módulo documenta haber corregido.

Enrutar decision-relay a través del handler completo de `a2a_send` cambia semántica de
lease/cola de un módulo con comentarios "MEDIDO"/tests de regresión extensos
(`decision-relay.test.cjs`, `decision-supersession.test.cjs`, `decision-later-rulings.test.cjs`,
`cursor-bytes-vs-chars.test.cjs`, `decision-self-delivery.test.cjs`) sin presupuesto para
verificar cada interacción con lease/dedupe dentro de este T3.

**Lo que sí hice**, consistente con "gate/shape/lease/queue/audit apply" en su intención
real (que la entrega efectivamente llegue por Orca, con el mismo control de backlog que
`a2a_send`/queue-drain ya tienen), fue darle a `decision-relay.cjs` el MISMO resolver y
transporte compartido que usa `a2a_send`/`findTarget`:

- `src/orca-target.cjs`'s `resolveOrcaTarget(project)` (mismo censo+roster+resolveOrca).
- `src/orca-send.cjs`'s `sendToOrcaTerminal(handle, body)` (mismo verbo
  submitted/delivered que `classifyDelivery` ya entiende).
- WezTerm queda **legacy, detrás de `WEZBRIDGE_WEZTERM_TRANSPORT=1`** — mismo patrón que
  T-0596 item 4 en los otros dos call sites. Con el flag off (default), decision-relay
  nunca intenta WezTerm.
- decision-relay conserva SU PROPIO enqueue/dedupe/attempt-cap/cooldown (que ya vive en
  `_intel/queues/<project>.jsonl`, la MISMA cola que drena `queue-drain.cjs`) — no se
  duplica la cola de a2a_send porque decision-relay nunca la llama.
- Self-send guard: igual que `a2a_send`, si `resolveOrcaTarget` resuelve al propio
  `ORCA_TERMINAL_HANDLE` del proceso, se rehúsa el intento de esa pasada (no debería
  ocurrir en producción — decision-relay corre como script/daemon, no como terminal Orca
  — pero el guard es gratis y consistente).

Marco esto como una **desviación deliberada y documentada** del literal "llamar a
a2a_send", con la razón puntual arriba. Si el operador prefiere el re-ruteo completo
(incluyendo lease/gate/cola de a2a_send), es un T3/T4 aparte con presupuesto para auditar
las interacciones de lease.

## orchestrator-waker.cjs — se queda WezTerm, gateado

El waker pokea **pane-0 fijo** (no resuelve por proyecto — su contrato es "el pane del
orquestador", una noción que no tiene equivalente Orca en este código: Orca resuelve por
`project`/`lane` name via roster, no por "pane-0"). Está armado por default OFF
(`WEZBRIDGE_ORCH_WAKER=1` explícito + `_intel/orch-waker.json`), y el propio T-0596 item 5
ya lo documentó como "WezTerm-only/desarmado". Se agrega el gate explícito
`WEZBRIDGE_WEZTERM_TRANSPORT=1` en el punto donde `event-handlers.cjs` arma el `send` real
(`daemon-cli.cjs`'s `.verified`), documentando la razón: sin un equivalente Orca de
"pane-0", migrar el waker es un rediseño de su modelo de direccionamiento (T3/T4 aparte),
no un simple swap de transporte.

## AC4 — backlog seal para decision-relay

`project-queue.cjs`'s `ORCA_DRAIN_NOT_BEFORE` (`2026-09-24T18:00:00Z`, override
`WEZBRIDGE_DRAIN_NOT_BEFORE`) ya sella las entradas que **llegan a la cola** con `time`
anterior al corte — eso cubre las aprobaciones que decision-relay YA había encolado. El
gap real: decision-relay intenta la entrega DIRECTA (Orca) ANTES de encolar, y esa
entrega directa no tenía ningún corte — una decisión aprobada 20-24/09 que quedó
pendiente en `_intel/.decision-relay/pending.json` (porque WezTerm no llegaba a nadie)
se entregaría ahora, recién viable, vía Orca — exactamente lo que el operador dijo que NO
debía pasar. Se exporta `ORCA_DRAIN_NOT_BEFORE`/`drainNotBeforeCutoff` desde
`project-queue.cjs` y decision-relay los reutiliza: una entrada cuyo `entry.at` (el `at`
del ruling) es anterior al corte nunca intenta Orca — se resuelve directo como
`resolveUndeliverable(..., 'backlog-sealed', ...)`, sin reintento, mismo patrón que
`authority.status === 'superseded'`.

## orchestrator-waker — gate agregado

`src/handlers/event-handlers.cjs` (composition root que arma el waker con `send =
daemon-cli.cjs`'s `.verified`, WezTerm real) ahora exige `WEZBRIDGE_WEZTERM_TRANSPORT=1`
ADEMAS de la decision de arming pre-existente (`WEZBRIDGE_ORCH_WAKER=1` / `orch-waker.json`).
Sin el flag, `daemon_status.orchestrator_waker` reporta `{armed:false, deliberate:true,
reason:'WezTerm transport disabled (...)'}` en vez de armar contra un transporte muerto —
mismo patron `deliberate` que ya distingue una decision de una falla en este modulo.
`test/orch-waker-arming.test.cjs` cubre ambos casos (flag on => armed, flag off => not
armed con reason correcto); el test COMPOSITION ROOT preexistente ("...registers the waker
when config arms it") se actualizo para setear el flag (documentado por que).

## Evidencia — fail-first y regresion

Rojo confirmado contra el codigo PRE-fix (`git stash push -u` de `src/decision-relay.cjs` +
`src/project-queue.cjs`, sha capturada, restaurado con `apply` — nunca `pop` — y dropeado
recien tras confirmar `git status` limpio): `test/decision-relay-orca-transport.test.cjs`
5/7 en rojo (el default seguia resolviendo/entregando por WezTerm, sin backlog seal).
Verde tras el fix: 7/7.

Regresion puntual (decision-relay + waker + backlog seal + queue-drain/a2a_send de T-0596,
sin re-tocar):
- `test/decision-relay.test.cjs`, `decision-supersession.test.cjs`,
  `decision-later-rulings.test.cjs`, `decision-self-delivery.test.cjs`,
  `cursor-bytes-vs-chars.test.cjs`, `decision-relay-orca-transport.test.cjs`,
  `decision-relay-scheduled.test.cjs`, `decision-relay-observation.test.cjs`,
  `queue-drain-orca-transport.test.cjs`, `queue-drain-backlog-seal.test.cjs`,
  `wezterm-transport-flag.test.cjs` → **62/62 verde**.
- `test/orch-waker-arming.test.cjs`, `daemon-liveness.test.cjs`,
  `waker-disarm-is-a-decision.test.cjs`, `clawtrol-disarm-is-a-decision.test.cjs`,
  `waker-consumer-can-fail.test.cjs` → **75/75 verde**.
- `test/project-queue.test.cjs`, `mcp-queue-sender-project.test.cjs` (exports nuevos de
  `project-queue.cjs` — `ORCA_DRAIN_NOT_BEFORE`, `drainNotBeforeCutoff`) → **46/46 verde**.
- `test/docs-curation-suite.test.cjs`, `fleet-rules-docs.test.cjs`, `daily-rollup.test.cjs`
  (doc-head de 7 lineas en `docs/a2a-protocol.md`/`docs/operations.md`) → **24/24 verde**
  (1 skip esperado: fixture que requiere `_docs-curation` del checkout del operador).

## `npm test` completo (sin `WEZBRIDGE_COMPANIONS_DIR`)

**1802 passed / 2 failed / 36 skipped** (1840 tests, ~97s). Los 2 fallos son EXACTAMENTE los
flakes de worktree ya conocidos por el brief de T-0596/esta carta:
- `test/model-tiers.test.cjs`: `ENOENT _intel/model-tiers.json` — el archivo real vive en el
  checkout del operador, no en este worktree aislado.
- `test/userprompt-routing-jev.test.cjs`'s T-0499 timing (460ms > 400ms budget bajo la carga
  de la corrida completa) — reproducido AISLADO (`node --test test/userprompt-routing-jev.test.cjs`)
  y pasa limpio (8/8), confirmando que es contencion de la corrida completa, no una regresion
  de esta carta.

Cero fallos nuevos atribuibles a T-0599.

## Reglas duras respetadas
- Cero sends en vivo contra un pane/terminal real — todo con dobles (`resolveOrcaTargetFn`/
  `sendToOrcaTerminalFn` inyectados en los tests nuevos, `sendPromptDeferredEnter`/
  `verifyPromptSubmission` inyectados en los legados).
- `git stash` nunca bare: `git stash push -u -m "t0599-redcheck-src"`, sha capturada de
  inmediato via `git stash list --format='%H %gs'`, restaurado con `apply <sha>` (nunca
  `pop`), dropeado recien tras confirmar `git status` limpio.
- No se toco `main`; rama `fix/t0599-wezterm-senders-orca` desde `origin/main` (7516718, PR
  #56 ya mergeado). Nunca merge propio.
- `gmail-routine-dispatch.cjs`: `git diff` confirma CERO cambios — solo inventariado.
- Paths tocados: `src/**`, `test/**`, `docs/**`, `_intel/briefs/**` — dentro de lo permitido.
  No se toco `src/mcp-server.cjs`, `src/pane-identity.cjs`, `bin/a2a-send-cli.cjs` (PR #57,
  T-0598, en abierto) salvo lectura.

<!-- doc-head: A2A contract and executable fleet rules, T-0327 -->
2026-09-06: 900-character refusal with explicit opt-in; ticketed cross-repo provenance; registered routine evidence.
Covers sender guards, steward findings, result criteria and queue/lease identity; read before dispatch or review.
Transport receipt is not work acceptance. Runtime activation and loaded MCP revision require separate verification.
<!-- /doc-head -->

# A2A Protocol

## Reglas de flota

| Regla | Cumplimiento ejecutable |
|---|---|
| Sobres de hasta **900 caracteres**. Si son mayores, escribir el detalle en `_intel/briefs/` y enviar un puntero. | `src/a2a-length-guard.cjs` y `a2a_send` en `src/mcp-server.cjs`: body de 901 sin `allow_long: true` se rehusa antes de escribir spill, encolar, registrar resultado o enviar. El opt-in conserva el cuerpo, sin anular byte cap ni `criteria:`. `WEZBRIDGE_A2A_SOFT_LIMIT` solo puede reducir el techo. |
| Trabajo de otro proyecto en una rama `fix/*` exige tarjeta del repo destino y correlacion exacta. Rama/draft PR no conceden permiso de merge. | `scripts/cross-repo-audit.cjs` consume procedencia de `actions.jsonl`; `scripts/fleet-steward.cjs` emite `cross-repo-unticketed` si falta tarjeta con repo+corr. `scripts/steward-gate.cjs` da 24h; repetir actividad no reinicia el plazo. |
| Todo bot periodico nace registrado con tarea y deja `run-*.json` en `_intel/routine-findings`. Exit 0 del scheduler no demuestra trabajo. | `scripts/routine-registry.cjs` lee declaraciones; `scripts/routine-audit.cjs` emite `routine-void` por ausencia de run en la ventana vencida. Un registro roto se informa localmente y no cancela el resto de la auditoria. |

El rechazo de sobres sustituye el auto-spill-and-send anterior por decision T-0327. `a2aSpill` sigue disponible como utilidad; el handler no la llama automaticamente. Un cuerpo menor al techo sigue necesitando verificacion de entrega: 900 no promete que un composer nunca trunque.

### Procedencia cross-repo

Al comenzar sobre una rama ya creada, registrar la rama real del checkout:

```text
node wezbridge/scripts/cross-repo-audit.cjs record --from finalorchestra --repo wezbridge --cwd <worktree> --corr <corr-de-la-tarjeta> --task <T-id>
```

El comando consulta Git, exige `fix/*` y solo declara exito si el action-log se escribio. El registro lleva `action=branch_work`, `project` destino y `extra.source_project`, `extra.branch`, `extra.worktree`. Un `task` declarado tambien debe coincidir con la tarjeta. La identidad no se infiere de un pane actual ni del nombre generico del autor Git. Sin procedencia registrada este guard no puede atribuir ramas creadas por comandos Git directos; no es cobertura de actividad no instrumentada. Una actividad distinta con corr valido no borra el historial de otra sin tarjeta.

### Registro y ventana de rutinas

Declaracion JSON en `_intel/routines/<nombre>.json`:

```json
{"routine":"bot-roster","repo":"wezbridge","task":"T-0327","cadence_hours":24,"registered_at":"2026-09-01T00:00:00Z","enabled":true}
```

Tambien se admiten bots (`bot:true`, `kind:bot` o `type:bot`) en `_intel/hidden-tasks.json` (array o `{tasks:[...]}`) o en `_intel/hidden-tasks/*.json`. Los documentos existentes `# Rutina: <nombre>` con `**Cadencia:** diaria|semanal` y `**Host:** ... (<repo>)` cuentan como declaracion; un JSON auxiliar sin `routine` no lo es. JSON especifico prevalece sobre documento para el mismo repo/rutina.

Primera ventana exigible: `registered_at + cadence_hours`. Luego se exige un run del mismo repo/rutina entre `ahora - cadence_hours` y `ahora`, nunca del futuro ni anterior al registro. Sin fecha explicita se usa la mas antigua entre creacion y mtime del archivo. `enabled:false` no arma la ausencia. Un run fresco pasa al clasificador existente: exit real y findings validos siguen siendo obligatorios; la presencia del archivo por si sola no prueba un resultado limpio.

Pruebas ejecutables: `test/a2a-900.test.cjs`, `test/a2a-send-spills-before-refusing.test.cjs` (contrato actualizado), `test/cross-repo-unticketed.test.cjs` y `test/routine-registration.test.cjs`.

**Scope**: any two panes reachable via the `wezbridge` MCP (Claude Code ↔ Claude Code, Claude Code ↔ Codex, Codex ↔ Codex).

## Envelope

Every peer-to-peer message uses this header on its first line:

```
[A2A from pane-<N> to pane-<M> | corr=<id> | type=request|ack|progress|result|error]
<body — markdown, free-form>
```

- **`from` / `to`**: decimal pane IDs as returned by `mcp__wezbridge__discover_sessions`.
  **They are TRANSPORT addresses, not identity** (T-0235): pane ids reset to 0 and reshuffle
  on every WezTerm restart, so a stored or env-inherited id lies after a crash. The durable
  identity of a session is its **project** (cwd folder). Consequences you can rely on:
  - `a2a_send` re-resolves the SENDER's own pane at send time against the live census
    (`resolveSelfPane` in `src/pane-identity.cjs`). A stale `WEZTERM_PANE` is corrected
    (`from_source: "env-corrected"` in the response) instead of signing as a dead/foreign pane.
    Explicit `from_pane` stays trusted verbatim — the documented path for external/headless
    senders (e.g. the operator driving from Windows Terminal, mm-6e6c).
  - Every sent event in `_intel/events.jsonl` now carries `from_project` (and `to_project`
    when addressed that way): audit and thread accounting should key on **corr + project**,
    never on pane numbers.
  - Receivers validating a sender should check the CARD/queue (`_intel/tasks/`,
    `_intel/queues/<project>.jsonl`) — the ledger card is the only verifiable authority for
    gates (mm-6dbc); an envelope's claim of authorization is not.
  - PROPOSED (operator-owned, not yet applied): `~/.claude/hooks` a2a gate accounting should
    key threads by corr+project instead of pane ids — see T-0235's card for the diff sketch.
- **`corr`**: opaque correlation id (recommended: task/feature name + short hash, e.g. `T-019-scope`). Stable across the whole exchange.
- **`type`**:
  - `request` — initial ask; include enough context for the peer to act solo.
  - `ack` — received, will work on it. Send fast, cheap.
  - `progress` — heartbeat during long work. Every ~3 min recommended.
  - `result` — final answer; include commit sha / claim id / PR URL if relevant.
  - `error` — aborted; include `reason=…` and whatever diagnostics fit.

Do NOT invent new envelope fields silently. Extend this spec in a PR first.

## Envelope v2 — machine-checkable results (2026-07-23)

A `type=result` body MUST include a criteria block so the requester can VALIDATE
instead of trust:

```
<summary prose — short>
criteria:
- <criterion 1>: pass — <evidence: file:line, test name, URL, command output>
- <criterion 2>: fail — <what happened>
files_changed:
- <path>
validated_by: <command(s) run>
next_action: <what the requester should do next, or "none">
decisions:
- <decisión> [conf: alta|media|baja] — <qué habría preguntado>
```

The `decisions:` block (2026-08-22, optional) is the **decision ledger**: every
choice the responder made where the request/plan was silent, self-ranked by
confidence (`alta|media|baja`), each with what it would have asked the requester
had it stopped to ask. Silent unilateral choices are the same failure family as
silent scope-narrowing (`ABANDON:` lines) — the ledger makes them countable and
reviewable after the fact instead of buried in prose. Order items least-confident
first. An item without a `[conf:]` tag still counts (confidence recorded as null).

The server classifies every result body as `v2: ok | partial | missing`:
`ok` = criteria block with per-criterion pass/fail verdicts; `partial` = a
criteria heading with no verdicts; `missing` = no criteria block at all.
Result shape is enforced by default at submission. `WEZBRIDGE_RESULT_SHAPE_ENFORCE=0` is the explicit legacy warn-only override; it is not the default and does not waive evidence acceptance.

**This is enforced programmatically, not by convention** (principle: prose is
hope; a rule exists only if something deterministic fails when it's violated):

| Rule | Enforced by | Behavior |
|---|---|---|
| v2 shape on results | `src/a2a-intel.cjs` inside `a2a_send` | Default submission rejects missing/partial required result shape via `checkResultShape`; the explicit legacy override permits warning-only submission |
| Decision ledger on results | `src/a2a-intel.cjs` (`detectDecisions`/`detectEvidence`) inside `a2a_send` | `decisions` (count+items with confidence) + `evidence` (count+items from criteria lines) persisted per result to `_intel/a2a-results.jsonl`; response exposes both counts |
| Every envelope audited | same, server-side | Metadata (never bodies) appended to `Py Apps/_intel/events.jsonl` |
| Open-thread tracking | same, server-side | `_intel/a2a-threads.json`: request opens corr → result awaits ack → ack closes; every send response lists `unacked_inbound` corrs the CALLER still owes acks for |
| Durable project addressing | `a2a_send {to_project}` + `src/project-queue.cjs` | Pane resolved via `pane-identity` AT SEND TIME (never a stored pane id — ids reset on WezTerm restart, the misroute class); the envelope is ALWAYS appended to `_intel/queues/<project>.jsonl`, and undelivered entries are retried by `scripts/queue-drain.cjs` (cron-able one-pass drain: sha1 dedupe, attempt cap 3 → flag-and-stop, 5-min cooldown, 24h age expiry) |
| Bookkeeping auto-ack on results | `a2a-intel.cjs autoAckResult`, called by `a2a_send` and the queue drain | A VERIFIED `type=result` delivery (`submitted` read back, tail intact) closes its awaiting-ack thread automatically (`a2a.thread-auto-acked` event + `auto_ack` line in `_intel/actions.jsonl`). The receipt acuse stops being an LLM turn; the requester's JUDGEMENT on the result (validate evidence, review→done) is never automated. Unverified deliveries keep the awaiting-ack nag |
| Contract recall on receive | `~/.claude/hooks/a2a-protocol-inject.cjs` (UserPromptSubmit) | Protocol contract injected next to every inbound envelope — immune to context rot |
| No finishing with open threads | `~/.claude/hooks/a2a-thread-gate.cjs` (Stop) | Session cannot end with an unanswered request or unacked result (max 2 blocks per corr, then warn-only) |

Server enforcement loads when a pane's wezbridge MCP restarts. Hook enforcement
loads at Claude session start. Codex panes: server-side enforcement applies
regardless; codex-native hook ports are tracked in
`docs/PLAN-control-plane-2026-07-23.md` (Phase 1.3).

## Structured gate-state lines (2026-07-27)

Prose-keyword watching has a precision ceiling (negation-blind, state-blind —
measured in the T-0008 oversight pilot). When a pane stops at an **operator gate**
(deploy, customer-send, payment-change, or any approval wait), it MUST declare the
gate machine-readably instead of relying on prose: send `type=progress` on the
thread's corr with a body whose FIRST line is

```
GATE:<kind>:<state> — <one-line detail>
```

- **`kind`**: lowercase-kebab gate kind, matching the repo's
  `.agent-workflow/graph.json` kinds where one exists (`customer-send`, `deploy`,
  `payment-change`, …).
- **`state`**: `waiting` (stopped, needs operator) | `cleared` (operator approved,
  proceeding) | `abandoned` (gate withdrawn, work re-planned).
- Example: `GATE:customer-send:waiting — 5 staged sends need operator command`.

Enforcement/consumption: the server (`a2a-intel.cjs`) parses the line from
`type=progress` bodies and records `{gate: {kind, state, detail, at}}` on the
thread in `_intel/a2a-threads.json`; the pane-beacon hook passes `GATE:*:*`
markers through verbatim to `_intel/pane-events.jsonl`, so an orchestrator's
Monitor can wake on gates with zero prose parsing. The inject hook states this
contract next to every inbound request.

## Sending

Preferred (B1, 2026-08-22) — address the PROJECT, not the pane. Pane ids reset on
WezTerm restart and stored ids are the whole "pane-8/pane-24" misroute class;
`to_project` resolves the live pane via `pane-identity` at send time AND records
the envelope durably in `_intel/queues/<project>.jsonl`:

Subdirectory projects (T-0328, 2026-09-06): resolution is by the cwd FOLDER NAME first, then by the
tab label; a project that lives as a subdirectory of another pane's cwd (infra/, marketing/ under
Py Apps/) never resolves to a sibling or to the parent — if no pane has that folder or that label,
the envelope is queued (`resolved_pane: null`), not delivered to a look-alike. Test:
`test/pane-identity-subdir.test.cjs`.

```js
await mcp__wezbridge__a2a_send({ to_project: "wezbridge", corr: "T-019", type: "request", body: "Hello" });
// -> { ok, submitted, to_project, to_pane: <resolved>, queued: true, corr, ... }
// no live pane / ambiguous -> { ok: false, queued: true } — the message is NOT lost:
// scripts/queue-drain.cjs (cron-able) retries it once the project's pane exists.
```

Also fine (v3.5+) — direct pane addressing, one call that builds the envelope,
sends it, and VERIFIES submission:

```js
await mcp__wezbridge__a2a_send({ to_pane: 1, corr: "T-019", type: "request", body: "Hello" });
// -> { ok, submitted: "submitted"|"stuck"|"unknown", corr, ... }
```

Raw form (also verified on v3.5+ servers):

```js
const r = await mcp__wezbridge__send_prompt(target, "[A2A from pane-10 to pane-1 | corr=T-019 | type=request]\nHello\n");
// only if r reports submitted === "stuck":
await mcp__wezbridge__send_key(target, "enter");
```

Two hard rules:

1. **Check the `submitted` field.** `send_prompt`/`a2a_send` (v3.5+) read the pane back and retry Enter automatically; only send `send_key("enter")` when the result reports `stuck`. On PRE-v3.5 servers there is no verification — there, always follow `send_prompt` with `send_key("enter")`; if no response, send a SECOND `enter` — never re-send the prompt (that double-types the body).
2. **Never send bash via `send_text` into a running TUI.** If the pane shows a live `Ctx:` or `gpt-X` status bar, your text is typed as a user prompt, not executed. Ctrl+C first or pick a real shell pane.

## Receiving

When you (a Claude or Codex session) see an envelope in your input:

1. Parse `from`, `corr`, `type`.
2. If `type=request`: optionally send an `ack` on the same `corr`.
3. Do the work. For work > 3 min, send `progress` envelopes on the same `corr`.
4. Send `result` (or `error`) on the same `corr` when done.
5. If `type=result` arrived addressed to you: since B1 the receipt-ack is
   AUTOMATED when the sender's delivery verified — you own the JUDGEMENT
   (validate the criteria evidence), not the acuse. Only send a manual
   `type=ack` for corrs that still show up in your `unacked_inbound` (i.e.
   deliveries the server could not verify).

## Push-vs-watch asymmetry (MANDATORY)

Claude has the `Monitor` tool; Codex does NOT. Therefore:

- **Every responder MUST push** `type=progress` every ~3 min during long work AND `type=result` on completion. Never assume the requester is watching.
- **Claude requesters** MAY start `Monitor` on the target pane for passive notification.
- **Codex requesters** MUST poll `mcp__wezbridge__read_output(target, 80)` between their own turns (every 1-3 min). No tight loops; fold polling into your normal task cadence.
- **When Claude responds to a Codex request**, remember Codex cannot Monitor you — push proactively regardless of how quick the work is.

## Observability (via `omni-watcher.cjs`)

The watcher scans every Claude pane's tail for envelopes and maintains:

```
pendingA2A: Map<corr, { from, to, type, firstSeen, lastSeen }>
```

- `type=request` opens a `corr`. Duplicate requests are idempotent.
- `type=ack` / `type=progress` refresh `lastSeen` (resets the orphan clock).
- `type=result` / `type=error` close the `corr`.
- Any `corr` older than 1h is swept automatically.

**`peer_orphaned` event**: when the watcher observes `session_removed` for a pane that is still `from` or `to` of an unresolved `corr`, it emits a P1 event with `{corr, dead_peer, survivor}` payload. OmniClaude consumes this event and notifies the survivor:

```
[A2A from OmniClaude to pane-<survivor> | corr=<X> | type=error | reason=peer_orphaned]
pane-<dead> died before resolving corr=<X>. You should stop waiting.
```

## Shared-repo safety

If two peer panes share a repo cwd, prefer different cwds via:

```bash
git worktree add ../<repo>-claude main    # one peer works here
# the other peer keeps the original cwd
```

If you can't set up a worktree, declare ownership explicitly in the envelope header:

```
[A2A from pane-A to pane-B | corr=X | type=request | owns=frontend/]
```

Never edit the other side's files silently.

## Deliberate non-goals for v1.0

- **Heartbeat enforcement by the watcher** — silent peers are not yet auto-flagged (rule exists in the globals, enforcement is Phase 3).
- **Envelope validation** — malformed envelopes are parsed as best-effort and otherwise ignored, not rejected to the sender.
- **Cryptographic signing** — the protocol assumes all panes are locally-trusted. Don't use A2A across trust boundaries.

## Delegation semantics: spawn vs fork (D3, 2026-08-24)

Stolen with pride from DeepSeek Harness (dsh, MIT) and Uncle Bob's swarm-forge, both of
which converged on this fleet's design independently. When a coordinator hands work to a
peer, DECLARE which of the two shapes the delegation is — they are not interchangeable:

- **spawn** — the peer is born with a CLEAN context: `spawn_session` (fresh by default
  since v3.5) + a brief file in `_intel/briefs/` + a short pointer envelope. Use for
  independent tracks: research, QA, a task that does not depend on the parent's
  conversation. The peer is continuable (progress/result over the same corr).
- **fork-lite** — the peer inherits the parent's ACCUMULATED context via a handoff file
  written by the dying/full session (`handoffs/…`), then a fresh session resumes from it.
  This is the fleet's `/clear` recycle (feedback: reciclar-pane-con-clear-no-spawn —
  handoff → `/clear` in the SAME pane → re-brief). Use when the work IS the continuation
  of prior context. dsh's insight worth keeping: a fork's value is the shared prefix —
  keep the handoff faithful to what the parent actually established; a handoff that
  re-frames the work destroys what forking was for.

Rule of thumb: continuation of a thread → fork-lite in the same pane; independent new
track → spawn. Either way the brief/handoff FILE is the contract — the envelope is only
a pointer to it.

## Sender-side enforcement added 2026-08-24 (runtime≠repo: applies per MCP server restart)

- **T-0238 dispatch gate**: `type=request` on `corr=T-NNNN` is refused while the card is
  blocked/gated — the card is the authority, not the envelope.
- **M1 lease-on-dispatch**: the same dispatch TAKES the card's lease for the executor
  (project name preferred). A provable lease conflict refuses the dispatch; lease
  plumbing failure fails open. Running-without-owner cannot be created via `a2a_send`.
- **R2 result shape**: `type=result` without a `criteria:` block carrying per-criterion
  `pass|fail` is refused before transport with the exact template to add.
  `WEZBRIDGE_RESULT_SHAPE_ENFORCE=0` reverts to the old warn-only detection.

## Context rescue: un pane no puede medir su propia ventana (2026-08-28)

**Un pane es estructuralmente ciego a su ocupación de ventana de contexto.** La barra
`Ctx Used: 98%  Context: 975k/1.0M` es chrome del terminal: la renderiza el CLI y **no entra en el
contexto del modelo**. Desde adentro, el único número visible es `total_tokens left` (~15M), que es
el **presupuesto total de sesión** — otra cantidad, que no dispara nada. El autocompact lo dispara
la ocupación de ventana, y **sólo la mide un observador externo** con `read_output`.

Reglas, las dos direcciones:

- **Receptor:** cuando un peer te avisa que estás cerca del límite, **aceptalo y volcá a disco**.
  No tenés instrumento con qué refutarlo. *"No lo puedo medir" no es "es falso".*
- **Emisor:** leé el pane con `read_output` y **citá la barra literal**. No afirmes un porcentaje
  de memoria ni de scrollback viejo.

Medido: el 2026-08-28 el pane de infra objetó con `conf: alta` que la premisa "estás al 99%" no se
verificaba, citando sus ~15M restantes, mientras su propia barra decía `987k/1.0M (99%)`. El mismo
pane, el mismo día, **acertó** al rechazar una afirmación no verificada sobre nameservers. La
diferencia no fue la actitud —verificar antes de aceptar, correcta en ambos casos— sino si el
instrumento existía desde donde miraba.

Corolario para el rescate: el handoff debe cubrir **las preguntas abiertas del operador**, no sólo
el estado técnico. Un `/clear` que las pierde reinicia una conversación que el operador ya tuvo.

## Corr de Eve, y el result que mueve la tarjeta (W2, 2026-09-01)

<!-- section-head: convención de corr `<T-id>:<slug>:<yyyymmdd>` (Eve la muta a `:rN`);
UN solo parser, `taskIdFromCorr` en src/a2a-intel.cjs, usado por el dispatch-gate, la
lease y el linker; los corrs con GUION (`T-0121-foo`) NO matchean, deliberado;
un `type=result` v2=ok sobre una tarjeta `running` la mueve a `review` con evidencia
`a2a-results.jsonl#time=…`, FAILED→failed, BLOCKED→blocked, NUNCA `done`;
lo que no liga sale como evento `result.unlinked` con razón (ambiguous|state=<s>|no-card|
no-task-corr|ledger-error|v2=<x>) y el steward lo levanta como `result-unlinked`.
Leer cuando: despachás a FinalOrchestra/Eve, o un result no movió la tarjeta que esperabas. -->

### La convención de corr

Un despacho a Eve setea el corr **ANTES** del submit:

```
<T-id>:<slug>:<yyyymmdd>        # T-0308:eve-consulta-graphjson:20260901
<T-id>:<slug>:<yyyymmdd>:rN     # la revisión N, mutada por Eve
```

Por qué así y no el jobId: el jobId no existe todavía cuando se arma el payload, y
`origin.correlationId` es el **único** string que sobrevive el viaje de ida y vuelta —
vuelve como `corr` del envelope A2A. El prefijo `T-NNNN:` es inequívoco: hoy hay 25
tarjetas vivas compartiendo corrs exactos, así que "el corr" a secas no identifica nada.
`scripts/eve-dispatch.cjs` arma el payload entero desde la tarjeta y `--apply` setea el
corr, mueve la tarjeta a `running` (por saltos legales: `queued → ready → running`) y
toma la lease `eve:<jobId>`.

`a2a_send` acepta `:` en el corr desde v3.5+W2 (charset `[a-zA-Z0-9._:-]{1,64}`). Un
servidor MCP anterior lo rechaza — runtime ≠ repo: hasta reiniciar, ese pane no puede
enviar con la convención.

### Un solo parser, tres lectores

`taskIdFromCorr(corr)` (`src/a2a-intel.cjs`) recorta un `:rN` final y matchea
`^(T-\d{4})(?::|$)`. Lo usan `checkDispatchGate`, `takeDispatchLease` y el linker. Antes
los dos primeros matcheaban `^T-\d{4}$` pelado, así que **toda tarjeta despachada con la
convención salía sin gate y sin dueño** — el agujero que T-0238 y M1 existen para tapar,
reabierto por un prefijo.

Los corrs con **guion** (`T-0121-foo`) NO matchean, y es deliberado: nunca fueron
gateados, así que matchearlos ahora gatearía retroactivamente hilos vivos que nadie
declaró como tarjeta. Si querés que un hilo sea una tarjeta, usá los dos puntos.

### El result mueve la tarjeta

`src/result-linker.cjs`, llamado desde `a2a_send` (las dos ramas: entregada y encolada) y
desde `scripts/result-link.cjs --once` (cursor de bytes sobre `a2a-results.jsonl`, arranca
en EOF).

| Entrada | Efecto en la tarjeta |
|---|---|
| `v2=ok`, tarjeta `running` | `review` + `--evidence "a2a-results.jsonl#time=<iso> corr=<corr> from=pane-N v2=ok"` |
| cuerpo con `FinalOrchestra <job>: FAILED` | `failed` |
| cuerpo con `FinalOrchestra <job>: BLOCKED` | `blocked`, `blocked_by: agent`, blocker = la primera línea después del veredicto |
| cualquier otra cosa | evento `result.unlinked` con razón |

**Nunca `done`.** `review` dice "hay algo que mirar"; `done` dice "lo miré y está bien", y
eso no lo puede afirmar el que entregó el trabajo. El steward tampoco cierra nada: misma
regla, mismo motivo.

Razones de `result.unlinked`: `ambiguous` (dos tarjetas con el mismo corr exacto — falla
cerrado), `state=<s>` (la tarjeta no estaba `running`), `no-card`, `no-task-corr`,
`ledger-error`, `v2=<x>` (un result sin bloque `criteria:` no mueve nada). El steward las
levanta como hallazgo `result-unlinked` (ventana 72 h, id `result:<corr>`).

Ligar dos veces la misma línea es **no-op**: la evidencia de la tarjeta ya la cita. Por eso
el cursor puede re-leer sin miedo, y por eso un re-link no genera hallazgo.

### El result encolado pasa por los mismos controles

Hasta W2, la rama `to_project` sin pane vivo retornaba **antes** del shape-check y del
registro: un result que viajaba por la cola nunca llegaba a `a2a-results.jsonl` y ningún
sobre malformado era rechazado por ese camino. Ahora los dos corren antes del early-return,
exactamente una vez por envío, y la respuesta lo dice:
`Ledger: T-0308 running → review` o `Ledger: result NOT linked (<razón>)`.

## Decisiones que el operador toma DENTRO de un pane (T-0326, 2026-09-02)

El operador decide donde está: en el pane de infra dice "olvidate de eso", en el de wabot
autoriza un restart, en el de wezbridge elige una opción. Si el pane **actúa sin escribirlo**,
el fleet se entera horas después por un result, o nunca, y las tarjetas quedan obsoletas
(medido cuatro veces el 2026-09-02: T-0253, T-0297, el restart de wabot, T-0310).

**Regla: primero el ruling, después la acción.** Si el operador decide sobre una tarjeta
(aprobar, cancelar, elegir una opción, autorizar un deploy o un restart), el pane escribe el
ruling ANTES de ejecutar:

```
node wezbridge/scripts/decidir.cjs T-NNNN aprobar|cancelar|diferir "<lo que dijo el operador, textual>" [--corr <id>] [--until <iso>]
```

que es exactamente

```
node _docs-curation/ledger.cjs decide T-NNNN --ruling approved|cancelled|deferred --why "<textual>" --source orchestrator-pane --by operator --corr <corr de la tarjeta>
```

Verbos: `approved` (sí, elegí esta opción, autorizado), `cancelled` (olvidate, no va),
`deferred` (después; lleva `--until`). `resolved` y `operator-gated` son vocabulario del
steward, no decisiones del operador. `--by operator` no es decorativo: es lo que distingue
la decisión del operador de una que un agente se atribuye.

**Guard:** el steward emite `decision-unrecorded` cuando una tarjeta gateada por el operador
(gate `operator` o `blocked_by: operator`) aparece en ready/running/review/done/cancelled sin un
ruling `by=operator` (o entrado por tablero/telegram). El gate lo vence a las 24 h. Se
autolimpia: un `decidir` tardío lo apaga. Época 2026-09-01.

## Reference

- Spec lives here (authoritative).
- Globals in `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md` include a compressed summary.
- Watcher implementation: `src/omni-watcher.cjs` (`scanA2AEnvelopes`, `pendingA2A`, `peer_orphaned` emission).
- OmniClaude's reaction handler: in its `CLAUDE.md` under "Event Reaction Decision Tree".

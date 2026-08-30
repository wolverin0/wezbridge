# Handoff del orquestador (pane wezbridge) — 2026-08-30, antes del reinicio de WezTerm

QUE CUBRE: estado de los 29 tracks de TRACKS.md, que quedo corriendo, y las decisiones
que esperan al operador. CUANDO LEER: al retomar el pane de wezbridge tras el reinicio.
TERMINOS: tracks, worktrees, fail-first, mutacion, Eve/FinalOrchestra, gate #1.

## Donde vivo

Rama `orch/tracks-ledger-20260830`. **No trabajar en el checkout compartido**: durante la
sesion mis commits aterrizaron dos veces en la rama de otro agente porque el HEAD se movia
abajo. Los agentes ya trabajan cada uno en su worktree bajo `Py Apps/_worktrees/`.

## Estado: 16 de 29 tracks cerrados, todos verificados corriendo YO las mutaciones

Cerrados con commit y evidencia en TRACKS.md. Los que valen releer:

- **T1** (72dc954) — un `a2a_send` con `to_pane` no dejaba rastro del CUERPO. Salio de que
  llego un pedido DESTRUCTIVO a infra y `_intel/queues/` tenia 0 de 72 envelopes con ese corr.
- **T8** (11716f1) — BUG DE PRODUCCION ARREGLADO: un body JSON malformado devolvia 500 en vez
  de 400.
- **T26** (7c09adf) — la suite no se podia correr desde un worktree. Encontro ademas que
  `rotate-pane.cjs` tenia el mismo bug y el interlock de `/clear` fallaba EN SILENCIO.
- **T27** (068677e) — `diffTasks` mataba el watcher con un TypeError sin capturar.

## Lo que queda EN CURSO

**T13 — `plugin-host`**: andamio commiteado (02335ca) y **fail-first ROJO commiteado**
(af6090d). El fix NO esta aplicado. **Es sacar `wezterm: wez` de `src/plugin-host.cjs:118`**
y el test se pone verde solo. El docstring de la linea 11 promete "zero-privilege... CANNOT
mutate pane state" y la 118 entrega el modulo entero: killPane, spawnInWorkspace, sendText.
Se puede arreglar sin romper nada — medido: ningun plugin usa `ctx.wezterm`, y el runtime
esta inerte porque `omni-watcher.cjs` no existe.

## DECISIONES QUE ESPERAN AL OPERADOR, ninguna urgente

1. **`github-webhook` hace fail-open.** `verifySignature` devuelve true si el secret esta sin
   definir O VACIO, y `server.listen(PORT)` sin host bindea todas las interfaces — la linea
   196 loguea `http://0.0.0.0:4180`. El patron correcto esta en el mismo repo:
   `dashboard-server-routes.cjs:312` hace `listen(PORT, BIND_HOST)`. NO se arreglo porque
   cambiaria el comportamiento de deployments vivos. Test que lo documenta:
   `github-webhook-signature-contract.test.cjs`.
2. **`voice-handler` sin spend-cap ni tope de tamano.** No tiene caller dentro de este repo.
3. **T29** — el parser lee `vault/active_tasks.md` como VACIO y con `errors: []`. El archivo
   tiene 3 tareas en formato `## Task:` y el regex espera `## T-NNN ·`. Hay que decidir si se
   migra el archivo o se ensancha el parser; lo que NO se discute es el silencio.
4. **T-0299** (infra) — el gateway de Hermes en 0.0.0.0 sin firewall.

## Eve / FinalOrchestra

El **gate #1 sigue abierto**. La causa no era la profundidad del worktree: `FACTORY_REPO` se
ata al cargar el modulo, asi que el Foreman apuntaba a otro repo. Ya montaron un par
Eve/worker dedicado a wezbridge. **`JOB-8dc6777a` esta AWAITING_APPROVAL** y ellos dijeron
explicitamente que lo apruebe el OPERADOR, no yo.

Rechace `JOB-8ccff66b` con NEEDS_REMEDIATION: sus 11 hallazgos reproducen exactos, pero el
censo se estrecho en silencio (busco solo `catch {}` literal cuando hay ~72 que devuelven un
default sin loguear) y declaro `limitations: []`. Ellos convirtieron eso en restriccion de
esquema: el receipt ahora RECHAZA el arreglo vacio.

## Tres errores de medicion que cometi, para no repetirlos

1. Un `status: error` con `last_line` vacio en `discover_sessions` es mux WEDGEADO, no crash.
   Casi corro una restauracion sobre un sistema vivo.
2. Los diagnosticos del IDE salen del BUFFER EN DISCO, no del commit. Con agentes mutando a
   proposito muestran estados transitorios — acuse a un agente de un defecto que no existia.
3. `git diff A..B` mide la diferencia entre dos ESTADOS, no lo que un commit hace. Casi acuso
   a otro agente de borrar 340 lineas que en realidad eran MIS commits faltantes.

Las tres son la misma forma: alcanzar un instrumento que contesta una pregunta parecida pero
distinta a la que hice.

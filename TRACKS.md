# TRACKS — backlog ortogonal para dispatch automatico

> QUE ES: cola de trabajo independiente para `/auto-harness` (Codex) y para jobs de
> FinalOrchestra/Eve. CUANDO LEER: antes de despachar cualquier agente a wezbridge.
> TERMINOS: track, ortogonal, fail-first, mutacion, criterio verificable.
> REGLA: cada track toca archivos DISTINTOS a proposito — dos agentes en paralelo no
> deben colisionar. Si dos tracks tocan el mismo archivo, es un solo track.

Escrito 2026-08-30. Todos los tracks salen de defectos MEDIDOS el 29-08, no inventados.

## Contrato que TODO track debe cumplir

Un track no esta hecho hasta que:

1. **Fail-first probado en los dos sentidos.** El test es ROJO contra `main` y VERDE con el
   cambio. Se pega la salida de las dos corridas, no se afirma.
2. **Mutacion corrida.** Se rompe el fix a proposito de UNA linea y se confirma que el test
   que lo cubre se pone rojo — y que SOLO ese se pone rojo. Un test que sobrevive a la
   mutacion de lo que dice cubrir no cubre nada.
3. **Suite completa verde**, o los fallos preexistentes nombrados uno por uno.
   Linea base medida 2026-08-29: `node --test --test-reporter=spec test/*.test.cjs` da
   **1090 tests, 1085 pass, 4 fail, 1 skip**. Los 4 fails son DATOS del ledger vivo, no
   codigo: T-0286 `running` sin `blocked_by`, kind `data-fix` de T-0262 fuera del
   vocabulario cerrado, y el path de `walksim` que no existe en disco. Un track que
   agregue un fail nuevo no esta hecho.
4. **Rama propia**, nunca commit directo a `main`.

---

## T1 — Un envelope mandado con `to_pane` no deja rastro de su CUERPO

**Archivos:** `src/mcp-server.cjs` (bloque `case 'a2a_send'`), `test/` (archivo nuevo).

**Medido en vivo el 2026-08-29.** El pane de infra recibio un pedido DESTRUCTIVO (borrar
directorios de releases en una VPS) que decia traer "autorizacion explicita del operador".
Al buscar su origen: `_intel/queues/` no tenia NADA — 0 de 72 envelopes con ese corr.

La causa esta en `src/mcp-server.cjs:1527`:

```js
const projectQueue = toProject ? require('./project-queue.cjs') : null;
```

Con `to_pane` no se encola. `a2aIntel.recordEvent()` SI corre siempre, asi que la
ATRIBUCION se conserva (quien mando y cuando) — el pedido resulto ser del pane de camiones.
Lo que se pierde es el CUERPO: se puede probar el emisor pero no auditar el ALCANCE de lo
que pidio. Para un pedido destructivo eso es la mitad que importa.

**Criterios:**
- Un `a2a_send` con `to_pane` persiste el cuerpo en algun registro durable, igual que uno
  con `to_project`. Test fail-first: hoy no lo hace.
- El `type=result` sigue yendo a `a2a-results.jsonl` como hasta ahora (control positivo:
  no romper lo que ya funciona).
- La persistencia es FAIL-SOFT: si el disco falla, el mensaje se entrega igual y se
  reporta el error. Nunca perder la entrega por no poder registrar.
- No cambia el comportamiento de `to_project`, que ya cumple.

**Cuidado:** el destino natural es la cola del proyecto, pero un `to_pane` no tiene proyecto
hasta resolverlo. Resolver el pane a proyecto via `pane-identity` es una opcion; escribir a
un registro aparte es otra. Elegir UNA y decir por que.

---

## T2 — `scripts/session-cost.cjs` no tiene un solo test

**Archivos:** `scripts/session-cost.cjs`, `test/` (archivo nuevo).

Escrito el 2026-08-29 y exporta `{ analizar, parseLineas, esLectura, informe }` justamente
para ser testeable, y nadie lo testeo. Mide algo que se usa para tomar decisiones de costo,
asi que un error suyo produce una decision equivocada con cara de dato.

**Criterios:**
- `esLectura()` clasifica bien: `cat`, `grep`, `sed -n`, `git log` son lectura; `rm`,
  `git commit`, `npm install` no lo son. Incluir el caso `cd X && grep` que el regex
  contempla explicitamente.
- `analizar()` cuenta rachas de solo-lectura: una racha de N turnos aporta N-1 colapsables,
  una racha de 1 aporta 0. Probar el borde exacto.
- Un turno con DOS llamadas cuenta como batcheado; con una, no.
- Los percentiles no explotan con lista vacia ni con un solo elemento.
- `parseLineas()` ignora lineas JSON rotas en vez de tirar — un transcript real las tiene.

**Fail-first obligatorio:** escribir primero un test que falle contra una version mutada de
la funcion, no contra la actual.

---

## T3 — El guard de composer da falso positivo sobre una lista de opciones

**Archivos:** `src/verified-send.cjs`, `test/composer-foreign-text-guard.test.cjs`.

**Observado dos veces el 2026-08-29.** El orch-waker reporto "su composer RETIENE texto sin
enviar" sobre panes que NO tenian texto tipeado: tenian abierto un prompt de seleccion
(AskUserQuestion) y el guard leyo la OPCION RESALTADA como si fuera contenido del composer.
Ejemplos reales: `"1. si, leer del pyproject (recomendado)"` y
`"colliard marta no puede ser 116.000 que queramos activa"` — el segundo SI era texto real,
el primero no.

Es benigno hoy (el pane igual esta esperando al operador) pero el guard afirma algo falso, y
un guard que dispara sobre comportamiento correcto entrena a ignorarlo.

**Criterios:**
- `composerHoldsForeignText()` devuelve `false` cuando lo que hay es una lista de opciones
  de seleccion, y `true` cuando hay texto realmente tipeado. Fail-first en los DOS sentidos.
- No debilitar el caso que el guard existe para atrapar: un composer con texto sin enviar
  sigue difiriendo la entrega. Ese test ya existe y debe seguir verde.
- Fixtures tomados de capturas REALES, no inventadas.

---

## T4 — `scripts/queue-drain.cjs` sin cobertura del camino de reintento

**Archivos:** `scripts/queue-drain.cjs`, `test/` (archivo nuevo).

Es el que rescata los envelopes con `ok:false`. Si se rompe, las entregas fallidas se
pierden en silencio — y el silencio es el modo de falla que mas caro salio esta semana.

**Criterios:**
- Una linea `ok:false` se reintenta; una `ok:true` no.
- Un reintento exitoso no deja la linea para reintentarse de nuevo (idempotencia).
- Un archivo de cola con una linea corrupta no aborta el drenaje de las demas.
- Cero entregas reales en el test: el transporte va inyectado.

---

## T5 — El indice de GitNexus quedo desactualizado y hay codigo nuevo

**Archivos:** ninguno del repo — es una corrida.

`npx gitnexus analyze --embeddings`. El hook viene avisando desde `7b42744` y desde entonces
entraron `verified-send.cjs`, `a2a-length-guard.cjs`, `session-cost.cjs` y cuatro suites
nuevas. Preservar embeddings con el flag: sin el se borran.

**Criterio:** `.gitnexus/meta.json` reporta un `stats.embeddings` mayor que cero y un SHA
posterior a `7b42744`.


---

# Cola de dispatch — formato `owns=` para /auto-harness

Cada track declara los archivos que POSEE. Dos tracks nunca comparten un `owns=`: es la
condicion para despachar varios agentes en paralelo sin que se pisen el commit.

Los cinco primeros (T1-T5) estan detallados arriba con su evidencia medida. Los que siguen
salen de un escaneo real del 2026-08-30: modulos de `src/` que no tienen NINGUN archivo de
test propio, ordenados por tamano. No son relleno — cada uno es codigo en produccion sin una
sola asercion encima.

## Contrato, otra vez, porque es lo unico que importa

Un track sin **fail-first en los dos sentidos** y sin **una mutacion que ponga rojo SOLO al
test que dice cubrir eso** no esta hecho, por mas verde que este. Un test que sobrevive a la
mutacion de lo que afirma cubrir no cubre nada.

## Defectos medidos

- [x] T1 — persistir el CUERPO de los envelopes mandados con `to_pane` — CERRADO 2026-08-30, commit 72dc954 (era 03d2282 antes del cherry-pick que lo saco de la rama equivocada). Verificado en worktree aislado: 3/3 pass, y revirtiendo el fix al estado pre-arreglo quedan rojos EXACTAMENTE los dos tests de to_pane mientras el control de to_project sigue verde. Reusa la cola de to_project resolviendo el pane a proyecto via pane-identity, con fallback a _dead-letter cuando no hay proyecto resoluble — una sola registry durable, no una segunda a medida. owns=src/mcp-server.cjs,test/a2a-to-pane-body-persist.test.cjs
- [x] T2 — tests para `session-cost.cjs` — CERRADO 2026-08-30, commit 39cbc0c, 26 tests. Verificado por el orquestador en worktree aislado: 26/26, y reproducida su mutacion 4 (el `actual > 1` de despues del loop, linea 89) que pone rojo exactamente un test. Hallazgo del agente: el fuente tiene DOS ramas con el mismo texto y su primer test solo pegaba en una. owns=scripts/session-cost.cjs,test/session-cost.test.cjs
- [x] T3 — el guard de composer confunde una lista de opciones con texto tipeado — CERRADO 2026-08-30, commit 1674360. Verificado en worktree aislado: 7/7, y la mutacion (deshabilitar looksLikeSelectedOption) pone rojo SOLO T3-A. Exige DOS senales antes de tratar el contenido como opcion, nunca una sola, para no fallar hacia el falso negativo. owns=src/verified-send.cjs,test/composer-foreign-text-guard.test.cjs
- [x] T4 — cubrir el camino de reintento de `queue-drain` — CERRADO 2026-08-30, commit e61a536, 10 tests. Verificado: 10/10, y muto yo la linea 339 de project-queue.cjs (el `delete state.pending[id]` de la rama de exito) -> 9 pass / 1 fail, el unico rojo el test de idempotencia. HALLAZGO: la semantica de reintento YA estaba cubierta en project-queue.test.cjs; el punto ciego real era la ORQUESTACION del script (loop multi-proyecto, filtro --project, exit code) que no tenia seam de inyeccion. Idempotencia intacta, sin bug. owns=scripts/queue-drain.cjs,test/queue-drain-retry.test.cjs
- [ ] T5 — reindexar GitNexus preservando embeddings owns=.gitnexus/

## Modulos en produccion sin un solo test

- [x] T6 — `telegram-streamer` (1184 lineas) — CERRADO 2026-08-30, commit 47213d9 (rebaseado sobre 71eba4d; el eb999a4 original quedo obsoleto), 61 tests. Verificado: 61/61, y CERO bytes cambiados en src/. HALLAZGO DE FONDO: el modulo no tiene module.exports y al requerirlo YA lee credenciales, arranca setInterval y puede POSTear a api.telegram.org. Solucion sin tocar el fuente: un loader con vm que compila solo lo anterior al marcador `// --- Startup ---`. Cubre el 100% de la logica de decision (rate-limit, dedup, truncado, eviction) y ~57% de las funciones, con lo no cubierto documentado. owns=src/telegram-streamer.cjs,test/telegram-streamer.test.cjs
- [x] T7 — `tasks-watcher` (330) — CERRADO 2026-08-30, 16 tests, verificado 16/16. Black-box por proceso hijo: el modulo no exporta nada y corre efectos al cargarse. HALLAZGOS: (a) refuto mi hipotesis midiendo — solo LEE active_tasks.md, su unico write es un seed de arranque, asi que el riesgo de atomicidad vive en OTRO modulo; (b) `diffTasks` sin null-guard mata el tick() con un TypeError sin capturar -> track T27; (c) en Windows `child.kill('SIGTERM')` no entrega SIGTERM real, asi que testear el handler seria afirmar una peculiaridad de la API y no el codigo — lo comento en vez de fingir un pass; (d) `fs.watch` arma asincronicamente y hay que dejar 300ms de settle, comentado para que nadie lo saque. owns=src/tasks-watcher.cjs,test/tasks-watcher.test.cjs
- [x] T8 — `dashboard-server-routes` (323) — CERRADO 2026-08-30, commit 11716f1, 7 tests. Verificado: 7/7, y revirtiendo su fix queda rojo SOLO BODY-B1. DOS RESULTADOS: (a) el guard de bind SI esta en el codigo y no solo en la doc — linea 297-309, process.exit(1) si el bind no es loopback sin WEZBRIDGE_API_TOKEN, independiente de NODE_ENV; (b) BUG REAL ARREGLADO: un body JSON malformado devolvia 500 en vez de 400 porque parseBody no le ponia statusCode al error, a diferencia del timeout (408) y el body-too-large (413) dos lineas mas arriba. Un error de INPUT se reportaba como error del SERVIDOR. Ademas lleno el hueco que el test preexistente admitia en su propio comentario: nunca se probaba que con token configurado una request sin Authorization diera 401. owns=src/dashboard-server-routes.cjs,test/dashboard-server-routes.test.cjs
- [x] T9 — `pane-discovery` (265) — CERRADO 2026-08-30, commit f4b0e21, 28 tests, verificado 28/28. 15 mutaciones con restauracion byte-identica confirmada por diff. LO QUE LO HACE VALIOSO: dos mutaciones de orden de status dieron CERO rojos en el primer intento — sus tests enfrentaban cada marcador contra idle, no los pares entre si. Agrego dos tests con ambos marcadores presentes a la vez y ahi si dieron rojo exacto. La mutacion encontro tests debiles, que es justo para lo que existe. Ademas verifico mi advertencia sobre la claim de lectura-vacia y determino que NO aplica a este modulo (es de un Monitor de bash aparte, ya corregido) en vez de obedecerla. owns=src/pane-discovery.cjs,test/pane-discovery.test.cjs
- [x] T10 — `daemon-status` (204) — CERRADO 2026-08-30, commit 81977ea, 23 tests, verificado 23/23. Corrigio el alcance del track: el modulo NO estaba sin cobertura, seis archivos lo ejercitan — pero siempre como plomeria de SUS tests, nunca como contrato propio. Cubrio lo genuinamente faltante: set/snapshot/_reset/startHeartbeat/readHeartbeat, mas dos bordes exactos que nada fijaba (cursorLagBytes==4096 y pendingOldestMinutes==30, los dos con `>` estricto). Sus dos mutaciones incluyen el peor bug documentado del propio archivo (T-0176). owns=src/daemon-status.cjs,test/daemon-status.test.cjs
- [x] T11 — `github-webhook` (202) — CERRADO 2026-08-30, commit dc06e68, 34 tests de cobertura + 3 de contrato de firma. Verificado: 34/34 y 3/3, CERO bytes en src/. HALLAZGO DE SEGURIDAD ELEVADO AL OPERADOR, sin arreglar a proposito: `verifySignature` hace FAIL-OPEN — linea 36 `process.env.GITHUB_WEBHOOK_SECRET || ''` colapsa 'sin definir' con 'definida vacia', y la 49 `if (!SECRET) return true`. Ademas `server.listen(PORT, ...)` en la 195 no pasa host y la 196 LOGUEA `http://0.0.0.0:PORT`. El header dice 'solo redes privadas', pero un webhook de GitHub tiene que ser alcanzable desde internet por definicion. El contraste: `dashboard-server-routes.cjs:312` hace `listen(PORT, BIND_HOST, ...)` — el patron correcto vive en el mismo repo. NO se arregla porque pasar fail-open a fail-closed rompe cualquier deployment que hoy corra sin secret: es decision del operador. El test lo DOCUMENTA (nombre `-signature-contract`, header explicito 'a census, not an accusation') para que el dia que se cierre, el test diga exactamente que cambio. AUTO-CORRECCION DEL AGENTE: su primer test de truncado solo verificaba el escape HTML y no el corte de 60 caracteres — lo encontro el mismo porque la mutacion NO dio rojo. Y dejo la mutacion 12 sin demostrar, explicando que el try/catch que la envuelve ya da el mismo resultado observable, en vez de fingir una prueba.
- [ ] T12 — `project-scanner` (200) owns=src/project-scanner.cjs,test/project-scanner.test.cjs
- [ ] T13 — `plugin-host` (197) owns=src/plugin-host.cjs,test/plugin-host.test.cjs
- [ ] T14 — `voice-handler` (185) owns=src/voice-handler.cjs,test/voice-handler.test.cjs
- [ ] T15 — `task-parser` (173) owns=src/task-parser.cjs,test/task-parser.test.cjs
- [ ] T16 — `media-handler` (155) owns=src/media-handler.cjs,test/media-handler.test.cjs
- [ ] T17 — `decision-push` (147) owns=src/decision-push.cjs,test/decision-push.test.cjs
- [ ] T18 — `routines-config` (134) owns=src/routines-config.cjs,test/routines-config.test.cjs
- [ ] T19 — `diff-reporter` (131) owns=src/diff-reporter.cjs,test/diff-reporter.test.cjs
- [ ] T20 — `dashboard-server-ipc` (126) owns=src/dashboard-server-ipc.cjs,test/dashboard-server-ipc.test.cjs
- [ ] T21 — `ntfy-notifier` (98) owns=src/ntfy-notifier.cjs,test/ntfy-notifier.test.cjs
- [ ] T22 — `rulings` (74) owns=src/rulings.cjs,test/rulings.test.cjs
- [ ] T23 — `permission-alerts` (63) owns=src/permission-alerts.cjs,test/permission-alerts.test.cjs

- [ ] T27 — `diffTasks` no tiene null-guard y una rama rota MATA EL WATCHER EN SILENCIO. Encontrado el 2026-08-30 por el agente de T7 MUTANDO, no leyendo: si la rama `added` de `diffTasks` recibe algo inesperado, tira un TypeError sin capturar que se lleva puesto el `tick()` entero de `src/tasks-watcher.cjs`. El proceso del watcher muere y nadie se entera — y ese watcher es el que mantiene `vault/active_tasks.md`, la fuente canonica del puntero de tarea activa segun docs/architecture.md. O sea: el estado que leen las otras sesiones se congela sin ninguna senal. Es exactamente la familia que este repo viene pagando toda la semana: un instrumento que deja de medir y sigue pareciendo vivo. CRITERIOS: un test fail-first que hoy sea ROJO pasandole a `diffTasks` la entrada que lo rompe; el guard que lo hace fallar RUIDOSAMENTE en vez de morir; y —lo que mas importa— que el `tick()` sobreviva a una excepcion de `diffTasks` y lo REPORTE, en vez de terminar el proceso. Un watchdog que se muere en silencio es peor que no tener watchdog. owns=src/tasks-watcher.cjs,test/tasks-watcher-diff-guard.test.cjs

## Higiene del plano de control

- [x] T26 — la suite no se podia correr desde un worktree — CERRADO 2026-08-30, commit 7c09adf. VERIFICADO CON CONTROL, que es lo que lo vuelve prueba: los mismos 5 archivos sensibles a ruta dan 69 tests / 67 pass / 2 fail en el checkout principal, IDENTICO en el worktree con el fix, y 54 / 48 / 6 en un worktree SIN el fix. O sea que sin arreglar, un worktree PIERDE 15 tests que ni siquiera corren y gana 4 fallos; con el arreglo mide lo mismo que el checkout. Los 2 que quedan son los del ledger, conocidos. ENCONTRO MAS DE LO PEDIDO: `scripts/rotate-pane.cjs` y `scripts/gen-projects-md.cjs` tenian la misma profundidad hardcodeada SIN escape hatch, y el interlock de /clear buscaba handoffs en el directorio equivocado EN SILENCIO — eso no era deuda de tests sino un bug de produccion. EL ENFOQUE ES EL CORRECTO: `git rev-parse --git-common-dir` siempre resuelve al .git del checkout PRINCIPAL, incluso desde adentro de un worktree, asi que es independiente de la profundidad por construccion en vez de adivinar candidatos.

- [ ] T24 — los 4 fails de la suite son DATOS del ledger, no codigo: T-0286 `running` sin `blocked_by`, kind `data-fix` de T-0262 fuera del vocabulario cerrado, y el path de `walksim` que no existe. Decidir por cada uno si se arregla el dato o se ensancha el registro, y dejarlo escrito owns=../_intel/kinds.json,../_intel/repos.json
- [ ] T25 — `DOCS-MAP.md` no menciona `TRACKS.md`, `monitoring.md` ni `scripts/session-cost.cjs`, todos creados o reescritos entre el 29 y el 30 de agosto. Un mapa de docs que no lista lo nuevo manda a leer el arbol entero owns=DOCS-MAP.md

## Lo que NINGUN track puede hacer

- Commitear a `main`. Rama propia siempre.
- Tocar `_intel/tasks/*.json` — el ledger se mueve por su FSM con `ledger.cjs`, nunca a mano.
- Debilitar un test existente para que pase. Si un test viejo estorba, se dice por que y se
  para: bajar la barra para cerrar un track es el fraude que este contrato existe para evitar.

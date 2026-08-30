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

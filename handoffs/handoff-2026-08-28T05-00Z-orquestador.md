# Handoff — orquestador — 2026-08-28 ~02:00 ART

> **Re-derivá el estado antes de citarlo.** Todo número de acá tiene fecha de medición.
> Un conteo sin fecha envejece a mentira, y esta sesión empezó justamente corrigiendo
> tres afirmaciones mías que habían dejado de ser ciertas.

## Qué pasó

El operador señaló que yo inventariaba defectos y no arreglaba ninguno: *"tenés tokens
ilimitados, subagentes, plan mode… no sos proactivo"*. Tenía razón, y la causa era
concreta: **pedí permiso que ya tenía**. El contrato de wezbridge
(`.agent-workflow/graph.json`) marca `tooling-fix`, `docs`, `sensor-change` y
`control-plane` como **sin gate** — sólo `egress-scope`, `guard-change` y `deploy`
necesitan al operador. Los nueve defectos que yo había puesto "fuera de alcance" eran
todos `tooling-fix`.

Después de eso: **12 tarjetas cerradas con evidencia**, verificada por mí en cada caso
corriendo los tests, no aceptando el reporte del ejecutor.

## Estado medido 2026-08-28 05:00Z

| | |
|---|---|
| suite wezbridge | **1040 tests · 1038 pass · 1 fail · 1 skip** (era 940 · 937 · 3 · 1) |
| el único fail | `intel-registries R.1` por **walksim** — decisión del operador |
| `_docs-curation` | 92 tests · 91 pass · 0 fail · 1 skip, **ahora corridos desde la suite de wezbridge** |
| `steward-gate` | exit 0 |
| `validate-intel` | 273 tarjetas, 48 abiertas, **0 violaciones** |

## Cerradas (12)

`T-0201` `T-0228` `T-0239` `T-0269` `T-0282` `T-0290` `T-0291` `T-0292` `T-0293`
`T-0294` `T-0295` `T-0296`. Cada una con `--evidence` que nombra commits y conteos.

Las que más valieron **no arreglaron bugs vivos: arreglaron instrumentos que mentían.**

- **T-0290** — la alarma de loop muerto escribía una tarjeta que `allTasks()` no veía. El
  archivo estaba en disco: ya se había disparado en producción y nadie se enteró.
- **T-0291** — 92 tests que ningún proceso ejecutaba. Peor: `doc-head.cjs`, un **módulo de
  producción**, nunca estuvo en git. Un clon limpio se llevaba 7 de 9 tests y le faltaba código.
- **T-0295** — el plano de control sin validar, y 3 tarjetas abiertas invisibles a la única
  métrica que mide si la orquestación funciona.

## ESPERANDO AL OPERADOR — nadie más puede decidirlas

1. **114 de 274 tarjetas existen en disco y NO en git** (desde T-0183, ~10 días), mientras
   `rulings.jsonl` sí está versionado. Ante pérdida de disco quedarían las decisiones
   apuntando a tarjetas inexistentes — explica los 19 ids gobernados sin archivo del 27-ago.
   **No las commiteé:** 10 archivos matchean palabras `token`/`password`/`service_role`;
   muestreé 3 y son prosa, no valores, pero 3 de 10 no alcanza y la historia de git es
   irreversible. El validador ahora las **cuenta en cada corrida**.
2. **`walksim`** — registrado el 05-08 con la nota "hasta que N0 corra el .git no existe";
   23 días después la carpeta no existe y no tiene tarjetas. Correr N0, darlo de baja, o
   dejar el rojo. Marcarlo `virtual` sería mentir sobre su naturaleza.
3. **¿`create` debe exigir criterios?** Hoy 16 de 49 abiertas no los tienen. Exigirlos
   **rompe el camino de intents del operador** (`clawtrol-bridge.cjs:411` manda `--criteria`
   sólo si el intent trae `acceptance`) — medido: 4 tests de clawtrol en rojo. Pineado como
   decisión abierta en `test/ledger-input-validation.test.cjs`.
4. **Los 12 `.cmd` del Task Scheduler no verifican que su proceso haya hecho algo.** Una
   rutina que arranca y muere se ve igual que una que nunca corrió. Primer paso sugerido:
   medir cuántas escriben evidencia hoy.
5. **`omniremote`** quedó en `repos.json` como `pending_operator`, no `active`: existe en
   disco con pane vivo y tarjeta, pero etiquetar un proyecto como activo es decisión suya.

## NO REHACER

- **No re-medir el contrato antes de trabajar.** `tooling-fix` no tiene gate. Preguntar
  permiso que ya se tiene es lo que hace inútil la delegación.
- **No commitear las 114 tarjetas** sin que el operador lo decida (punto 1).
- **No convertir la deuda heredada del validador en gate.** Hay test que lo impide: 93 sin
  criterios y 16 sin repo son legacy, y un guard que dispara sobre lo que ya no se puede
  cambiar se desactiva en una semana.
- **No exigir criterios en `create`** hasta el punto 3.
- **No angostar el cargador de tareas del steward** para hacerlo coincidir con el del ledger:
  rompe `board-fresh-gate` y lo haría salir **verde sobre archivos que no puede ver** —
  cambia un defecto de visibilidad por uno de silencio. Contrato documentado en `loadTasks`.

## Correcciones de método que costaron caro

Se pierden en un `/clear` y valen más que el estado.

1. **Mutar es la única forma de saber si un test prueba algo** — y el `assert` de que el
   reemplazo aplicó es lo que impide que la mutación misma mienta. Me pasó **dos veces**
   reportar una mutación que no había mutado: el `replace` no matcheaba y el archivo quedaba
   intacto. Verde falso.
2. **Nunca encadenar un `git checkout` detrás de un paso que puede fallar.** Me borró trabajo
   sin commitear **dos veces la misma noche**. La primera la nombré y no cambié la práctica.
3. **Medir "no rompe nada" contra las suites que uno eligió no es medirlo.** Un ejecutor
   afirmó "no rompe en ningún orden"; corrí la suite entera y dio 9 rojos, 4 en la ruta viva
   del operador.
4. **Un mensaje de commit que describe un cambio que el commit no contiene** es prosa que no
   coincide con el artefacto — lo cometí yo, arreglando la cadena que existe para impedirlo.
   Corregido en el mensaje de `b9783ea`.
5. **Código muerto hace mentir a las mutaciones.** Con dos sitios que asignan lo mismo, mutar
   uno solo reporta "cubierto" cuando el que decide es el otro.
6. **No despachar un agente al mismo working tree donde uno trabaja.** Mi commit quedó varado
   sobre su rama y la suite quedó ilegible. Para eso existe `isolation: worktree`.

## Vivo, no bloqueado

`T-0294` dejó `src/rulings.cjs` como criterio único de "el ruling más reciente", con un
**guard de fuente**: un test falla si algún consumidor deja de importarlo o vuelve a ordenar
a mano. Que hoy coincidan no alcanzaba.

`stall-fix` quedó libre y sin tarea. No le despaché el hallazgo de los `.cmd` porque es
decisión del operador, no un bug.

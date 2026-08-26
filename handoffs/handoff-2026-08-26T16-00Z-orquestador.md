# Handoff del pane orquestador — sesión 2026-08-25/26
# Qué cubre: estado real de la flota, las 17 decisiones que esperan al operador, los hilos
# A2A abiertos con cada pane, lo que se commiteó, y las correcciones de método que costaron
# caro. Leer ENTERO antes de tocar nada; re-derivar el ledger antes de citar cualquier número.
# Términos: ledger, A2A, dos espacios de pane-id, escritura atómica, WAL, KB-60, Coolify.
# Escrito por: pane orquestador (wezbridge). Fecha: 2026-08-26 ~13:00 ART.

## Lo primero, y no es un detalle de estilo

**Re-derivá el estado antes de citarlo.** Esta sesión empezó con el operador diciendo "la
bandeja está superseeded, me complicás la vida" y terminó, catorce horas después, con el
mismo error: leí tildes en la pantalla de un pane y los interpreté como "aplicado" cuando
significaban "decidido". Ocho retractaciones documentadas en la sesión, siete de causa
propia. La forma dominante — cinco de las ocho — fue **amplificar el hallazgo de otro con
más confianza que la fuente**, y ninguna la detecté yo: las cazaron los panes midiendo.

La regla que funcionó las dos veces que funcionó: **pedir el bloque criteria con artefactos
nombrados en vez de cerrar sobre mi lectura**. Si vas a decirle algo al operador como hecho,
tenés que poder nombrar el comando con el que lo comprobaste; si no podés, la frase dice
"el pane midió X, no lo verifiqué".

Convención adoptada con infra y vinculante para los dos lados: escribir **DECIDIDO** y
**APLICADO**, nunca un tilde. Un símbolo con dos significados es cómo un tablero empieza a
mentir.

## Estado de los panes (identidad por PROYECTO, nunca por número)

Los pane-id **no son direccionables**: esta máquina corre dos sockets mux que numeran los
mismos panes distinto (mm-0dc1). Usá siempre `to_project`.

- **infra** — activo y sano, contexto bajo tras reciclado. Hilo abierto:
  `hermes-gateway-crashloop-20260826`. Le autoricé correlacionar picos de latencia con
  checkpoints del WAL y PREPARAR sin aplicar el movimiento de `executions.db`.
  Tiene además un gate de operador propio: cambio de nameservers de alquilerespergamino.com.
- **whatsappbot-final** — el operador lo maneja directo. Dos pedidos míos SIN responder:
  el estado de la medición continua de UISP (corr uisp-outages-2039-20260825) y la
  validación por ping de los 17 retiros (corr kb60-validacion-retiros-20260826).
- **memorymaster** — el operador lo maneja directo (hilo Obsidian/wiki curada).
- **axion / rifas / companion** — panes codex, el operador los maneja.

## Lo que ESPERA AL OPERADOR (17 — re-derivar, no copiar de acá)

Decisiones que tomó hoy y que NO se reabren:
- **T-0273 token de Telegram: NO se rota.** Textual: "no lo voy a cambiar nunca, olvidate".
  Riesgo aceptado. **No volver a proponerlo.**
- **T-0271 UISP: cerrado por el operador** ("ya lo solucioné, está superseedeado"). Nadie
  tocó el balanceo de los WAN.

Lo que sigue abierto y por qué importa, agrupado:
- **Ventana de Coolify** (T-0267 + T-0274): tres pasos, un minuto sin panel, CERO impacto en
  clientes — verificado, coolify no publica puerto público. Sin decisiones abiertas: es un sí.
- **Seguridad**: T-0285 (gateway de Hermes acepta trabajo por red sin sandbox y sin firewall,
  verificado con ss + ufw + config), T-0223 y T-0236 (credenciales), T-0275 (el guardián de
  credenciales es una lista fija y no puede fallar).
- **Clientes**: T-0216 (3 personas esperando su palabra), T-0280 (17 antenas que pueden
  seguir en techos ajenos — la validación por ping está pedida).
- **WarehouseVision** (T-0277, T-0284): el operador decidió retirarla, pero el inventario
  real son NUEVE tareas y no seis, y una de las dos vivas es un BACKUP. Respaldo de las nueve
  definiciones ya tomado en `_intel/backups/`. Falta su respuesta sobre esas dos.
- **Memoria**: T-0278 (el 99,9% del corpus no se puede corregir desde MCP por gate de tenant,
  y el error dice "does not exist", que manda al lugar equivocado), T-0279 (40 vaults
  huérfanos: 32 borrado seguro, 8 VERSIONADOS que necesitan `git rm --cached`).

## Hilos A2A y trabajo despachado

- infra: crashloop del gateway (arriba), y T-0286 con su addendum medido.
- whatsappbot-final: los dos pedidos sin responder mencionados arriba.
- Todo lo demás cerrado con ack de ambos lados.

## Commiteado hoy en wezbridge

`7a1db70` guard de to_pane desconocido + detección de divergencia de sockets ·
`b788758` cierre de la vía sin auditar de send_prompt · `9a2fb43` nombrado de los pass sin
artefacto · `436445b` el audit de prompt nombra al llamador · `766de53` los tests dejan de
escribir en el log vivo de la flota · `5b02746` + `0276655` (en `_docs-curation`) autoridad
del operador verificable en el ledger.

## Las cinco correcciones de método que costaron caro hoy

1. **Un chequeo verde solo vale si podés NOMBRAR el artefacto que produjo.** Cinco instancias
   en dos días. `weakPasses` lo aplica ahora sobre los results de A2A.
2. **El exit code de un pipeline es del ÚLTIMO comando.** Un `ssh ... | tail` convirtió un
   timeout de escaneo en exit 0: el gate de seguridad se habría reportado cumplido sin escanear.
3. **Un vacío solo es evidencia si probaste que el instrumento graba.** Con esa mitad sola se
   archivan agujeros reales como "no encontré nada"; sin ella se inventan hallazgos.
4. **Un cero de una API con permisos puede ser falta de permiso, no ausencia.** "Beszel tiene
   cero alertas" era un artefacto de token read-only; tenía quince.
5. **Antes de citar "X aparece en la mayoría de las fallas", decí cuántos son X en total.**
   El firmware 8.7.25 "explicaba" todo porque es la mitad de la flota.

## Lo que NO hay que hacer

- No reiniciar el gateway de Hermes: reiniciar un proceso intermitente resetea el contador y
  borra la evidencia.
- No matar los 5 MCP acumulados hasta saber si compiten por las mismas rutas.
- No tocar carpetas de proyecto: el operador es dueño de su selección, orden y borrado.
- No proponer la rotación del token de Telegram.
- No cerrar T-0263 por "aplicado": el fix corre pero NO está probado; se verifica viendo la
  memoria amesetar sobre 24-48 h.

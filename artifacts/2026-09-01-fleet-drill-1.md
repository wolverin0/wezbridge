# fleet-drill — UNKNOWN (live) — 2026-09-01T22:21:59.856Z
<!-- DRILL T31. Nueve checks del loop wezbridge<->Eve<->graph; veredicto por check con lado y salida pegada.
     Un check sin salida pegada es UNKNOWN, no GREEN. Exit 3. -->

| # | veredicto | lado | ms | check |
|---|---|---|---|---|
| 0 | GREEN | wezbridge | 0 ms | pre-flight |
| 1 | GREEN | wezbridge | 204 ms | Tarjetas reales [DRILL] nacen desde el graph de wezbridge (docs queued, deploy blocked/operator) |
| 2 | GREEN | wezbridge | 327 ms | Dispatch a Eve: payload impreso; con --job-id-docs se aplica corr+lease eve:<job> |
| 3 | GREEN | finalorchestra | 48 ms | Eve honra el gate: el job de deploy queda AWAITING_APPROVAL citando graph.json |
| 4 | UNKNOWN | operator | 60604 ms | Decision sin teclado: el operador toca Aprobar en el tablero; ruling con source board-app; teclas sobre los corrs del drill = 0 |
| 5 | UNKNOWN | wezbridge | 0 ms | El dueño se entera: decision-relay --once → decision.queued|delivered para la tarjeta aprobada |
| 6 | GREEN | wezbridge | 563284 ms | Eve devuelve por a2a_send: linea en a2a-results.jsonl con el corr del drill, sobre real guardado verbatim |
| 7 | GREEN | wezbridge | 1 ms | El result mueve la tarjeta: docs en review con evidencia a2a-results.jsonl (auto en el send, o result-link --once) |
| 8 | GREEN | wezbridge | 1334 ms | Steward y gates consistentes con censo REAL: sin hallazgos malos para las tarjetas del drill; steward-gate 0; validate-intel 0 |
| 9 | GREEN | wezbridge | 32 ms | Waker honesto (STUB-ONLY dentro del live: no se manda un poke falso al orquestador real) |

## Salidas

### Check 0 — GREEN
```
daemon :4200 ok (? panes)
tablero :4272 ok (decisiones=7)
finalorchestra http://127.0.0.1:3100 ok (200)
```

### Check 1 — GREEN
```
T-0309 queued gate=null
T-0310 blocked gate=operator blocked_by=operator
```

### Check 2 — GREEN
```
corr=T-0309:drill-docs:20260901 mode=CHANGE
T-0309 running lease=eve:JOB-c50da275-e537-4490-976f-885baecf0b90
```

### Check 3 — GREEN
```
JOB-451a6fc3-5445-44e5-ada0-d530513a028f AWAITING_APPROVAL (graph.json kinds.deploy.gate=operator)
```

### Check 4 — UNKNOWN
```
el operador no aprobo T-0310 en 1 min (push NO registrado en events.jsonl)
```

### Check 5 — UNKNOWN
```
todavia no hay ruling aprobado sobre la tarjeta de deploy (paso 4): se mide cuando el operador toque Aprobar
```

### Check 6 — GREEN
```
corr=T-0309:drill-docs:20260901:retry from=pane-57 v2=ok 743 chars
--- sobre real verbatim ---
FinalOrchestra JOB-119cf195-15c0-4852-8aef-70f9fbcff149: blocked
summary: Foreman did not produce a controller-correlated draft PR
verdict: blocked
criteria:
- C1 docs/DRILL.md existe con header de 7 lineas: fail — E
- C2 node --test test/*.test.cjs sin fails nuevos: fail — E
- C3 Run the repository-defined verification commands for the ...: fail — E
- C4 Attach controller-bound evidence for the final revision.: fail — E
- C5 Use a reviewer session that is separate from the implemen...: fail — E
- C6 Address the full objective as written; explicitly declare...: fail — E
evidence: E=EVD-fc08c849-2a22-4d11-8cf8-7ab60c79df8d
files_changed:
- docs/DRILL.md
next_action: factory result JOB-119cf195-15c0-4852-8aef-70f9fbcff149 --detail full
```

### Check 7 — GREEN
```
T-0309 blocked (veredicto blocked) via auto (linker dentro de a2a_send)
evidencia "a2a-results.jsonl#time=2026-09-01T22:16:20.411Z corr=T-0309:drill-docs:20260901:retry from=pane-57 v2=ok"
```

### Check 8 — GREEN
```
steward findings=29, ninguno malo para T-0309/T-0310
steward-gate exit 0: steward-gate GREEN: 29 findings, 8 past deadline and all ruled.
validate-intel exit 1
```

### Check 9 — GREEN
```
stub-only
pokes=3 delivered=0 unverified=2 pending=0
held-composer.jsonl 1 linea (dedupe ok)
control positivo submitted => delivered
```

## Mediciones
```json
{
  "checks": {
    "1": 204,
    "2": 327,
    "3": 48,
    "4": 60604,
    "5": 0,
    "6": 563284,
    "7": 1,
    "8": 1334,
    "9": 32
  },
  "hops": {
    "create->dispatch": 44239,
    "dispatch->result": 1304234,
    "result->review": 238
  },
  "delivery": {},
  "verification": {},
  "keystrokes": null,
  "unknown": 8
}
```

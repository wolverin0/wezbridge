# Propuesta: curación de MCP servers por proyecto (menos procesos node)
> Qué cubre: por qué hay ~96 procesos node, censo medido 2026-08-22, y la propuesta de
> allowlist por proyecto. Los cambios tocan `~/.claude.json` (operator-owned) → ESTA ES UNA
> PROPUESTA, el operador la aplica o la aprueba. Ahorro estimado: ~25-30 procesos / ~500MB+
> por sesión de flota típica. Leer cuando: se retome la tarea de curación MCP o se agregue
> un MCP server nuevo. Respuesta corta a "¿por qué no comparten node?": el protocolo MCP
> con transporte stdio ES un proceso por server POR SESIÓN — no es bug de wezbridge.

## Por qué pasa (no es un bug)
- MCP con transporte **stdio** = cada sesión de Claude Code lanza SU copia de cada server
  configurado. N panes × M servers = N×M procesos. El shell (PowerShell/cmd) es irrelevante.
- Los 7 servers GLOBALES cargan en TODAS las sesiones aunque el proyecto no los use.
- `gitnexus` global se lanza vía **npx**, que re-resuelve el paquete en cada arranque
  (proceso extra + latencia de arranque por sesión).

## Censo medido (2026-08-22, 96 procesos node vivos)
| Firma | Procesos | RAM |
|---|---|---|
| gitnexus-mcp | 11 | 251 MB |
| playwright-mcp | 12 | 130 MB |
| stitch-mcp | 10 | 91 MB |
| memorymaster-mcp | 7 | 222 MB |
| wezbridge-mcp | 7 | 91 MB |
| heroui-mcp | 4 | 1 MB |
| tsserver (no MCP — leak conocido) | 6 | 1.441 MB |
| otros (daemon, dev-servers, workers) | 60 | 4.092 MB |

Config actual: 7 globales (magic, wezbridge, stitch, memorymaster, gitnexus, meta-ads http,
notebooklm-mcp) + 19 proyectos con servers propios (playwright casi siempre).

## Propuesta de allowlist (el operador aplica en ~/.claude.json)
| Server | Hoy | Propuesto | Razón |
|---|---|---|---|
| wezbridge | global | **global (queda)** | toda la flota lo usa (A2A, spawn, colas) |
| memorymaster | global | **global (queda)** | memoria transversal; candidato futuro a HTTP compartido |
| gitnexus | global vía npx | **por-proyecto, path directo a node** | solo repos indexados lo usan; npx duplica arranques. Con 7 panes son 11 procesos/251MB para 2-3 usuarios reales |
| stitch | global | **por-proyecto** (frontendesigner, marketing, UI) | 10 procesos/91MB y se usa en diseño únicamente |
| magic | global | **por-proyecto** (UI) | ídem |
| notebooklm-mcp | global | **quitar del global** (el CLI `nlm` cubre; o por-proyecto research) | corre siempre para uso esporádico |
| meta-ads | global (http) | queda (http = sin proceso local) | costo cero |
| playwright | 19 proyectos | consolidar: solo donde hay validación browser activa | 12 procesos/130MB |

## Beneficio estimado
Sesión de flota típica (5 panes): de ~35 procesos MCP a ~12 → ~500MB+ menos y arranques de
sesión más rápidos. El tsserver-leak (1,4GB en 6 procesos) es aparte y ya tiene watchdog.

## Cómo aplicar (cuando el operador apruebe)
1. Mover claves de `mcpServers` global → bloque `mcpServers` del proyecto en `~/.claude.json`
   (o `.mcp.json` en el repo para que viaje con el proyecto).
2. gitnexus: reemplazar `npx gitnexus` por el path resuelto del binario.
3. Un pane por vez, verificando con `/mcp` que el proyecto ve lo que necesita.
4. Medir de nuevo el censo (comando en este doc §Censo) y anotar el delta acá.

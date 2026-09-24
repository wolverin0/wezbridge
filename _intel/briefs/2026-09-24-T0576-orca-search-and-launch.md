<!-- doc-head: T-0576 brief — Orca v1.4.209 orca_search MCP tool & agent-launch integration -->
Covers: src/orca-search.cjs, src/mcp-server.cjs (orca_search tool), test/orca-search.test.cjs,
and evaluation of native agent-launch (PR #21832) for terminal agent prompt delivery.
Read when: implementing or extending Orca search or agent launch integration in wezbridge.
<!-- /doc-head -->

# T-0576 — Orca v1.4.209: orca_search en MCP Server y soporte agent-launch (T3)

task_id=T-0576 tier=T3. Repo wezbridge.

## Contexto
Orca fue actualizado a v1.4.209 (`orca --version` = `1.4.209`). Esta versión incorpora dos capacidades clave para la flota y los orquestadores:
1. **CLI `orca search`**: Motor de búsqueda indexado cross-session en SQLite con soporte para consultas semánticas/full-text, filtros de agente, scope (`conversation` vs `all`), ordenamiento (`relevance` vs `newest`), límites y paginación con cursor.
2. **`feat(agent-launch)` (PR #21832)**: Entrega nativa de launch prompt a agentes de terminal con espera de readiness (y fallback con timeout de 30s), eliminando la fragilidad de escribir directamente por keystrokes en composers recién abiertos.

## Objetivos de la Tarjeta

### 1. Módulo `src/orca-search.cjs`
Implementar un módulo limpio y testeable con:
- `searchSessions({ query, scope, agent, path, since, sort, limit, fresh, debug, runOrcaFn })`:
  Ejecuta `orca search <query>` con los flags correspondientes y `--json`.
  Permite inyección de `runOrcaFn` para desacoplar tests unitarios del ejecutable real.
- `getIndexStatus({ runOrcaFn })`:
  Ejecuta `orca search --index-status --json` y devuelve el estado del indexador.
- **Manejo de índice desactivado**:
  Cuando `orca search` retorna `result.kind === "unavailable" && result.reason === "disabled"` (o `enabled: false` en status), retornar un mensaje de error claro y accionable para el agente y operador:
  `"Orca Session Search indexing is currently disabled. Enable 'Session Search / History indexing' in Orca Desktop Settings to activate cross-session search."`

### 2. Exposición como herramienta MCP en `src/mcp-server.cjs`
Registrar la herramienta `orca_search`:
- `description`: "Search the full text of indexed Orca agent sessions cross-project (user/assistant turns, commands, and tool output). Requires Orca v1.4.209+."
- `parameters`:
  - `query` (string, required): Texto a buscar.
  - `scope` (string, optional: "conversation" | "all", default "all").
  - `agent` (string, optional: filtrar por identidad de agente, ej. "claude", "codex", "antigravity").
  - `sort` (string, optional: "relevance" | "newest", default "relevance").
  - `limit` (number, optional: cantidad de resultados, default 20, max 100).
  - `fresh` (boolean, optional: esperar hasta 5s a que el indexador reconcilie).

### 3. Suite de Tests en `test/orca-search.test.cjs`
Tests exhaustivos usando test doubles / mocks inyectables:
- Consulta de `getIndexStatus` con índice activo e inactivo.
- Consulta de búsqueda con índice inactivo -> verifica mensaje instructivo y exitoso (sin throw no manejado).
- Consulta de búsqueda con índice activo -> verifica pasaje exacto de flags (`--scope`, `--agent`, `--sort`, `--limit`, `--fresh`) y parsing del objeto `result`.
- Manejo de fallos de proceso / JSON malformado.

### 4. Evaluación de `agent-launch` (PR #21832)
Revisar la integración de launch prompts en `scripts/spawn-session.cjs` o `scripts/agent-spawner.cjs`.
Dejar un informe/blueprint conciso en `_intel/briefs/2026-09-24-agent-launch-analysis.md` detallando:
- Cómo Orca v1.4.209 detecta readiness del agente.
- Comparativa vs `poke-pane` / `send-prompt` actual.
- Recomendación de adopción para la flota.

## Criterios de Aceptación
1. `orca_search` disponible en `src/mcp-server.cjs` ejecutando `orca search` con flags y `--json`.
2. Error descriptivo y accionable si el índice está deshabilitado.
3. `test/orca-search.test.cjs` pasa completamente con mocks.
4. Documento de análisis de `agent-launch` generado.
5. `npm test` corre sin regresiones.
6. PR limpio en rama `feat/t0576-orca-search-and-launch` hacia `main`.

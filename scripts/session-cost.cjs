#!/usr/bin/env node
'use strict';
/**
 * session-cost.cjs — qué costó una sesión, y por qué.
 *
 * QUÉ MIDE: turnos, batching, tamaño de contexto reenviado, y cuántos turnos
 * eran trivialmente colapsables. Lee un transcript .jsonl de Claude Code.
 * CUÁNDO LEER ESTO: cuando una sesión se sintió cara o el modelo empezó a
 * afirmar estados que no midió. TÉRMINOS: turnos, batching, cache_read,
 * contexto reenviado, rachas colapsables.
 *
 * POR QUÉ EXISTE. Medido el 2026-08-29 sobre una sesión propia de 852 turnos:
 *
 *     una sola llamada por turno, 852 de 852. CERO batching, nunca.
 *     contexto medio reenviado: 544.781 tokens. p90: 920.063. máx: 997.581.
 *     total: 1.150.033.872 tokens.
 *
 * El system prompt YA decía "issue them together in one message rather than one
 * per turn", y el CLAUDE.md global YA decía que la zona útil es ~100k y que la
 * podredumbre entra a 300–400k. Las dos reglas estaban escritas y las dos se
 * violaron el 100% del tiempo. Prosa es esperanza: por eso esto es un script y
 * no un párrafo más.
 *
 * Y mató una propuesta: iba a envolver las llamadas MCP "charlatanas" al estilo
 * code-mode de Uber. La medición dice que los 101 `a2a_send` fueron 101 envíos
 * DISTINTOS, ni un fan-out. No había nada que colapsar. El derroche no estaba en
 * la forma de las herramientas sino en el ritmo de un-paso-por-turno.
 *
 *   node scripts/session-cost.cjs <transcript.jsonl>
 *   node scripts/session-cost.cjs --latest        (la sesión más reciente de este proyecto)
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

/** Comandos que sólo leen: dos seguidos casi siempre pudieron ir juntos. */
const SOLO_LECTURA = /^\s*(cd\s+[^&|;]*&&\s*)?(cat|head|tail|sed -n|grep|rg|ls|wc|find|echo|git\s+(log|status|show|diff|branch|remote))\b/;
const HERRAMIENTAS_LECTURA = new Set(['Read', 'Grep', 'Glob']);

function parseLineas(archivo) {
  const turnos = [];
  const usos = [];
  for (const linea of fs.readFileSync(archivo, 'utf8').split('\n')) {
    if (!linea.trim()) continue;
    let r;
    try { r = JSON.parse(linea); } catch { continue; }
    const m = r.message;
    if (!m) continue;

    if (m.usage) {
      const u = m.usage;
      usos.push({
        contexto: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
        fresco: u.input_tokens || 0,
        cacheRead: u.cache_read_input_tokens || 0,
        cacheWrite: u.cache_creation_input_tokens || 0,
        salida: u.output_tokens || 0,
      });
    }

    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    const llamadas = m.content.filter((b) => b && b.type === 'tool_use');
    if (llamadas.length) turnos.push(llamadas);
  }
  return { turnos, usos };
}

/** Un turno cuenta como de-sólo-lectura si TODAS sus llamadas lo son. */
function esLectura(llamada) {
  const nombre = llamada.name;
  if (HERRAMIENTAS_LECTURA.has(nombre)) return true;
  if (nombre !== 'Bash' && nombre !== 'PowerShell') return false;
  return SOLO_LECTURA.test(String((llamada.input && llamada.input.command) || '').trim());
}

function analizar({ turnos, usos }) {
  const llamadas = turnos.reduce((n, t) => n + t.length, 0);
  const batcheados = turnos.filter((t) => t.length > 1).length;

  // Rachas de turnos consecutivos que sólo leyeron: cada racha de N pudo ser 1.
  const rachas = [];
  let actual = 0;
  for (const t of turnos) {
    if (t.every(esLectura)) { actual += 1; continue; }
    if (actual > 1) rachas.push(actual);
    actual = 0;
  }
  if (actual > 1) rachas.push(actual);
  const colapsables = rachas.reduce((n, r) => n + (r - 1), 0);

  const ctx = usos.map((u) => u.contexto).sort((a, b) => a - b);
  const pct = (p) => (ctx.length ? ctx[Math.min(ctx.length - 1, Math.floor(ctx.length * p))] : 0);
  const total = (k) => usos.reduce((n, u) => n + u[k], 0);
  const reenviado = total('fresco') + total('cacheRead') + total('cacheWrite');

  const porNombre = new Map();
  for (const t of turnos) for (const l of t) porNombre.set(l.name, (porNombre.get(l.name) || 0) + 1);

  return {
    turnos: turnos.length,
    llamadas,
    batcheados,
    rachas: rachas.length,
    rachaMayor: rachas.length ? Math.max(...rachas) : 0,
    colapsables,
    requests: usos.length,
    reenviado,
    cacheRead: total('cacheRead'),
    cacheWrite: total('cacheWrite'),
    salida: total('salida'),
    ctxMedio: usos.length ? Math.round(reenviado / usos.length) : 0,
    ctxMediana: pct(0.5),
    ctxP90: pct(0.9),
    ctxMax: ctx.length ? ctx[ctx.length - 1] : 0,
    porNombre: [...porNombre.entries()].sort((a, b) => b[1] - a[1]),
  };
}

const n = (x) => x.toLocaleString('es-AR');

function informe(a) {
  const L = [];
  L.push('');
  L.push(`  turnos con herramienta : ${n(a.turnos)}`);
  L.push(`  llamadas totales       : ${n(a.llamadas)}`);
  L.push(`  turnos batcheados      : ${n(a.batcheados)}  (${a.turnos ? (100 * a.batcheados / a.turnos).toFixed(1) : 0}%)`);
  if (a.batcheados === 0 && a.turnos > 20) {
    L.push('    ^ CERO batching. Cada request reenvía la conversación entera: los turnos');
    L.push('      son el costo. Llamadas independientes van en UN mensaje.');
  }
  L.push('');
  L.push(`  rachas de sólo-lectura : ${n(a.rachas)}  (la mayor: ${n(a.rachaMayor)} turnos seguidos)`);
  L.push(`  turnos colapsables     : ${n(a.colapsables)}  ← piso conservador, sólo lo trivialmente independiente`);
  if (a.ctxMedio) L.push(`  reenvío evitable       : ~${n(a.colapsables * a.ctxMedio)} tokens`);
  L.push('');
  L.push(`  requests               : ${n(a.requests)}`);
  L.push(`  CONTEXTO REENVIADO     : ${n(a.reenviado)} tokens`);
  L.push(`    cache read           : ${n(a.cacheRead)}`);
  L.push(`    cache write          : ${n(a.cacheWrite)}`);
  L.push(`    salida               : ${n(a.salida)}`);
  L.push('');
  L.push(`  contexto medio/request : ${n(a.ctxMedio)}`);
  L.push(`  mediana / p90 / máx    : ${n(a.ctxMediana)} / ${n(a.ctxP90)} / ${n(a.ctxMax)}`);
  if (a.ctxMediana > 400000) {
    L.push('    ^ mediana por encima de 400k. La zona útil declarada es ~100k y la');
    L.push('      podredumbre entra a 300–400k: acá el costo y los errores suben juntos.');
  }
  L.push('');
  L.push('  llamadas por herramienta:');
  for (const [nombre, k] of a.porNombre.slice(0, 12)) L.push(`    ${String(k).padStart(5)}  ${nombre}`);
  L.push('');
  return L.join('\n');
}

function ultimoTranscript() {
  const base = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(base)) return null;
  const candidatos = [];
  for (const proy of fs.readdirSync(base)) {
    const dir = path.join(base, proy);
    let entradas;
    try { entradas = fs.readdirSync(dir); } catch { continue; }
    for (const f of entradas) {
      if (!f.endsWith('.jsonl')) continue;
      const p = path.join(dir, f);
      try { candidatos.push({ p, t: fs.statSync(p).mtimeMs }); } catch { /* ignorar */ }
    }
  }
  candidatos.sort((a, b) => b.t - a.t);
  return candidatos.length ? candidatos[0].p : null;
}

function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('uso: node scripts/session-cost.cjs <transcript.jsonl> | --latest');
    process.exit(2);
  }
  const archivo = arg === '--latest' ? ultimoTranscript() : arg;
  if (!archivo || !fs.existsSync(archivo)) {
    console.error(`no encontré el transcript: ${archivo || '(ninguno)'}`);
    process.exit(2);
  }
  console.log(`\n  ${path.basename(archivo)}`);
  console.log(informe(analizar(parseLineas(archivo))));
}

if (require.main === module) main();

module.exports = { analizar, parseLineas, esLectura, informe };

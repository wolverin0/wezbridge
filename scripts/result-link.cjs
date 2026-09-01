#!/usr/bin/env node
'use strict';
/**
 * result-link.cjs — cursor de bytes sobre _intel/a2a-results.jsonl que liga
 * cada result NUEVO a su tarjeta con src/result-linker.cjs (running -> review,
 * FAILED -> failed, BLOCKED -> blocked; nunca done).
 * Uso: node scripts/result-link.cjs --once   (cron-able; siempre exit 0)
 * Estado en _intel/.result-link/cursor.json. La PRIMERA corrida arranca en EOF,
 * igual que src/orchestrator-waker.cjs: las lineas anteriores son historia y
 * re-ligarlas moveria de golpe cada tarjeta vieja que compartiera corr.
 * Cubre los results que a2a_send registro por la rama de COLA y los que
 * entraron con un servidor MCP viejo (runtime != repo).
 */
const fs = require('node:fs');
const path = require('node:path');
const { intelDir, recordEvent } = require('../src/a2a-intel.cjs');
const linker = require('../src/result-linker.cjs');

const stateDir = (dir) => path.join(dir, '.result-link');
const cursorFile = (dir) => path.join(stateDir(dir), 'cursor.json');

function readCursor(dir) {
  try { return JSON.parse(fs.readFileSync(cursorFile(dir), 'utf8')); } catch { return null; }
}

function writeCursor(dir, bytes) {
  try {
    fs.mkdirSync(stateDir(dir), { recursive: true });
    const tmp = `${cursorFile(dir)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ bytes, updated_at: new Date().toISOString() }, null, 2));
    fs.renameSync(tmp, cursorFile(dir));
  } catch { /* fail-soft: sin cursor se re-lee, y ligar es idempotente por linea */ }
}

/**
 * Lee las lineas COMPLETAS nuevas y devuelve { lines, bytes } — `bytes` es el
 * fin de la ultima linea entera, nunca el fin del archivo: una linea a medio
 * escribir se lee en la corrida siguiente en vez de perderse partida.
 */
function readNew(file, from) {
  let raw;
  try { raw = fs.readFileSync(file); } catch { return { lines: [], bytes: from }; }
  if (raw.length < from) from = 0;   // rotacion/truncado: el cursor vuelve a cero
  const chunk = raw.subarray(from);
  const text = chunk.toString('utf8');
  const lastNl = text.lastIndexOf('\n');
  if (lastNl === -1) return { lines: [], bytes: from };
  const complete = text.slice(0, lastNl + 1);
  const lines = complete.split('\n').filter((l) => l.trim());
  return { lines, bytes: from + Buffer.byteLength(complete, 'utf8') };
}

function runOnce(dir = intelDir()) {
  const file = path.join(dir, 'a2a-results.jsonl');
  const saved = readCursor(dir);
  if (!saved) {
    let size = 0;
    try { size = fs.statSync(file).size; } catch { /* todavia no existe */ }
    writeCursor(dir, size);
    return { seeded: true, seen: 0, linked: 0, unlinked: 0, reasons: {} };
  }
  const { lines, bytes } = readNew(file, Number(saved.bytes) || 0);
  const out = { seeded: false, seen: lines.length, linked: 0, unlinked: 0, reasons: {} };
  for (const raw of lines) {
    let line;
    try { line = JSON.parse(raw); } catch { continue; }   // una linea rota no tumba la pasada
    if (!line || line.event !== 'a2a.result') continue;
    const r = linker.link(line, {
      runLedger: (args) => linker.defaultRunLedger(args, dir),
      readTasks: () => linker.defaultReadTasks(dir),
      recordEvent,
    });
    if (r.linked) out.linked += 1;
    else if (!r.noop) {
      out.unlinked += 1;
      out.reasons[r.reason] = (out.reasons[r.reason] || 0) + 1;
    }
  }
  // El cursor avanza DESPUES de ligar: un corte a mitad re-lee las lineas, y
  // ligar dos veces la misma linea ya es no-op (la evidencia la cita).
  writeCursor(dir, bytes);
  return out;
}

module.exports = { runOnce, readNew, cursorFile };

if (require.main === module) {
  const r = runOnce();
  const reasons = Object.entries(r.reasons).map(([k, v]) => `${k}=${v}`).join(' ');
  process.stdout.write(r.seeded
    ? 'result-link: cursor sembrado en EOF (primera corrida) — 0 new, 0 linked\n'
    : `result-link: ${r.seen} new, ${r.linked} linked, ${r.unlinked} unlinked${reasons ? ` (${reasons})` : ''}\n`);
  process.exit(0);
}

#!/usr/bin/env node
'use strict';
/**
 * promise-guard-hook.cjs — Stop hook: a turn may not end on a PROMISE.
 *
 * Why (operator, 2026-08-19, twice): panes end turns with "ahora arreglo X" /
 * "sigo con Y" and then STALL — a promise is text, nothing re-invokes the
 * model, and the prose rule "always arm a loop" decays under context pressure.
 * This hook is the deterministic version: if the final assistant message
 * promises future work AND no continuation mechanism was armed this turn
 * (ScheduleWakeup / Monitor / a running loop), the stop is BLOCKED (exit 2)
 * and the model is told to either do the work now or arm a loop.
 *
 * Anti-noise rules (a guard that fires on compliant turns is worse than none):
 *  - only the TAIL of the final message is scanned (a promise mid-report that
 *    ends in evidence is fine);
 *  - tight pattern list, first-person future work only;
 *  - if stop_hook_active is set (we already blocked once this stop), allow
 *    through — never loop forever;
 *  - WEZBRIDGE_PROMISE_GUARD=0 disables.
 *
 * Exit codes: 0 allow · 2 block (stderr is fed back to the model).
 */

const fs = require('node:fs');

const PROMISE_RE = new RegExp(
  [
    '\\bahora\\s+(lo\\s+|la\\s+|los\\s+)?(hago|arreglo|corro|armo|implemento|escribo)\\b',
    '\\bme\\s+pongo\\s+con\\b',
    '\\bsigo\\s+con\\s+(el|la|los|las|eso|esto)\\b',
    '\\barranco\\s+(con|por)\\b',
    '\\bempiezo\\s+(con|por)\\b',
    '\\bahora\\s+sigo\\b',
    '\\bpr[oó]ximo\\s+paso:\\s*$',
    "\\bnow\\s+I(['’]ll| will)\\b",
    "\\bnext,?\\s+I(['’]ll| will)\\b",
  ].join('|'),
  'i'
);

// Evidence that THIS turn armed (or is inside) a continuation mechanism.
const CONTINUATION_TOOLS = new Set(['ScheduleWakeup', 'Monitor', 'CronCreate']);
// How much of the final text counts as "the ending". A promise buried in a
// report whose ENDING is evidence should not fire.
const TAIL_CHARS = 500;
// How many transcript entries back to look for an armed continuation.
const LOOKBACK = 25;

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

function lastEntries(transcriptPath, n) {
  // The transcript is JSONL and can be large; read the last ~256KB only.
  const fd = fs.openSync(transcriptPath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const want = Math.min(size, 256 * 1024);
    const buf = Buffer.alloc(want);
    fs.readSync(fd, buf, 0, want, size - want);
    const lines = buf.toString('utf8').split('\n').filter((l) => l.trim());
    const out = [];
    for (const line of lines.slice(-n * 3)) {
      try { out.push(JSON.parse(line)); } catch { /* partial first line */ }
    }
    return out.slice(-n);
  } finally { fs.closeSync(fd); }
}

function main() {
  if (process.env.WEZBRIDGE_PROMISE_GUARD === '0') process.exit(0);

  let input = {};
  try { input = JSON.parse(readStdin()); } catch { process.exit(0); }

  // Never fight the harness in a block-loop: one block per stop, maximum.
  if (input.stop_hook_active) process.exit(0);

  const transcript = input.transcript_path;
  if (!transcript || !fs.existsSync(transcript)) process.exit(0);

  let entries;
  try { entries = lastEntries(transcript, LOOKBACK); } catch { process.exit(0); }

  // Find the final assistant text, and whether any continuation tool ran
  // in the lookback window.
  let finalText = null;
  let continuationArmed = false;
  for (const e of entries) {
    const content = e && e.message && Array.isArray(e.message.content) ? e.message.content : [];
    for (const block of content) {
      if (block.type === 'tool_use' && CONTINUATION_TOOLS.has(block.name)) {
        // ScheduleWakeup with stop:true is ENDING a loop, not arming one.
        const armed = !(block.name === 'ScheduleWakeup' && block.input && block.input.stop === true);
        if (armed) continuationArmed = true;
      }
      if (e.type === 'assistant' && block.type === 'text' && block.text && block.text.trim()) {
        finalText = block.text;
      }
    }
  }

  if (!finalText) process.exit(0);
  const tail = finalText.slice(-TAIL_CHARS);
  if (!PROMISE_RE.test(tail)) process.exit(0);
  if (continuationArmed) process.exit(0);

  process.stderr.write(
    'PROMISE-GUARD: tu mensaje final promete trabajo futuro ("ahora hago/sigo con/arranco...") ' +
    'pero este turno no armó ninguna continuación (ScheduleWakeup/Monitor/loop). ' +
    'Una promesa sin loop es un turno perdido: nadie te va a volver a invocar. ' +
    'HACÉ el trabajo prometido ahora, o armá /loop self-paced (o ScheduleWakeup/Monitor) antes de terminar. ' +
    'Un turno termina con evidencia o con un loop armado — nunca con una promesa.'
  );
  process.exit(2);
}

main();

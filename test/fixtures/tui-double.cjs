'use strict';
// tui-double.cjs — doble de un composer de TUI para T-0303. Raw mode.
// MEDIDO 2026-09-02 (Windows 10 / ConPTY, wezterm): aunque la app active DECSET
// 2004, wezterm NO envuelve el paste en ESC[200~ (ConPTY no propaga el modo), y
// `send-text` CON o SIN --no-paste llega igual: UN chunk con todo el texto y sus
// saltos de linea. Si el TUI se defiende por RAFAGA (Ink / Claude Code: chunk
// de >1 char con salto = paste, saltos suaves) el sobre entra entero; si no
// (crossterm sin bracketed paste: cada salto es Enter) se fragmenta.
// Dos modos:  default = Ink (rafaga)  ·  TUI_DOUBLE_STRICT=1 = cada salto es Enter.
// Bracketed paste real (ESC[200~..201~) se respeta en los dos modos.
// Cada submit va a submits.jsonl y cada chunk a chunks.jsonl en el cwd.
const fs = require('node:fs');
const path = require('node:path');
const OUT = path.join(process.cwd(), 'submits.jsonl');
const CHUNKS = path.join(process.cwd(), 'chunks.jsonl');
const STRICT = process.env.TUI_DOUBLE_STRICT === '1';
const BORDE = '─'.repeat(70);
const log = [];
let buf = '';
let inPaste = false;
let n = 0;

function render() {
  process.stdout.write('\x1b[2J\x1b[H');
  process.stdout.write(`tui-double ${STRICT ? 'STRICT (cada salto = Enter)' : 'ink (rafaga = paste)'}\n`);
  for (const l of log.slice(-20)) process.stdout.write(l + '\n');
  process.stdout.write(BORDE + '\n');
  const lines = buf.split('\n');
  process.stdout.write('❯ ' + lines[0] + '\n');
  for (const l of lines.slice(1)) process.stdout.write('  ' + l + '\n');
  process.stdout.write(BORDE + '\n');
}
function submit() {
  n += 1;
  fs.appendFileSync(OUT, JSON.stringify({ n, text: buf, at: new Date().toISOString() }) + '\n');
  log.push(`[submitted #${n}] ${JSON.stringify(buf.length > 90 ? buf.slice(0, 90) + '…' : buf)}`);
  buf = '';
}
function typeKeys(text) {
  for (const ch of text.replace(/\r\n/g, '\r')) {
    if (ch === '\r' || ch === '\n') submit();
    else if (ch === '\x03') process.exit(0);
    else if (ch >= ' ' || ch === '\t') buf += ch;
  }
}
function onChunk(chunk) {
  fs.appendFileSync(CHUNKS, JSON.stringify({ len: chunk.length, newline: /[\r\n]/.test(chunk), bracket: chunk.includes('\x1b[200~'), head: chunk.slice(0, 30) }) + '\n');
  let pending = chunk;
  for (;;) {
    if (inPaste) {
      const end = pending.indexOf('\x1b[201~');
      if (end < 0) { buf += pending.replace(/\r\n?/g, '\n'); return; }
      buf += pending.slice(0, end).replace(/\r\n?/g, '\n');
      pending = pending.slice(end + 6);
      inPaste = false;
      continue;
    }
    const start = pending.indexOf('\x1b[200~');
    const head = start < 0 ? pending : pending.slice(0, start);
    if (!STRICT && head.length > 1 && /[\r\n]/.test(head)) buf += head.replace(/\r\n?/g, '\n');
    else typeKeys(head);
    if (start < 0) return;
    pending = pending.slice(start + 6);
    inPaste = true;
  }
}

process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { onChunk(chunk); render(); });
process.on('exit', () => { try { process.stdout.write('\x1b[?2004l'); } catch { /* ignore */ } });
fs.writeFileSync(OUT, '');
fs.writeFileSync(CHUNKS, '');
process.stdout.write('\x1b[?2004h');
render();

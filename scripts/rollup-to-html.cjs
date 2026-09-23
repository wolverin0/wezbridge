#!/usr/bin/env node
'use strict';
/**
 * rollup-to-html.cjs — renderiza un rollup/retro markdown (daily-rollup.cjs,
 * weekly-retro.cjs) como una pagina HTML autocontenida, tema oscuro, tablas
 * reales. NO es un parser CommonMark: cubre exactamente lo que ESOS dos
 * generadores emiten (headers #/##/###, tablas GFM con pipes, listas con
 * "- ", parrafos) — deliberado, un parser generico es mas superficie para
 * bugs de escapado que nunca se ejercita con el resto del markdown del repo.
 * Uso: node scripts/rollup-to-html.cjs <input.md> [output.html]
 * Sin output explicito, el destino es wezbridge/artifacts/rollup-<base>.html
 * (T-0551 — el operador abre esto a la manana en vez del .md crudo).
 * Puros exportados (markdownToHtml, defaultOutputPath) — test sin FS.
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Negrita/código inline dentro de una celda o párrafo ya escapado. */
function inline(s) {
  return escapeHtml(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.+?)`/g, '<code>$1</code>');
}

function isTableSeparator(line) {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line);
}

function splitRow(line) {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((c) => c.trim());
}

/**
 * Convierte el markdown de daily-rollup.cjs/weekly-retro.cjs a HTML. Lee
 * línea por línea con un cursor manual (no regex global sobre todo el
 * archivo) porque las tablas necesitan mirar la línea siguiente para saber
 * si son tabla (línea separadora) o un párrafo que arranca con "|" suelto.
 */
function markdownToHtml(md) {
  const lines = String(md || '').split(/\r?\n/);
  const out = [];
  let i = 0;
  let inList = false;
  const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { closeList(); i += 1; continue; }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i += 1; continue;
    }

    // Tabla GFM: línea con "|" seguida de una línea separadora "---|---".
    if (line.includes('|') && lines[i + 1] && isTableSeparator(lines[i + 1])) {
      closeList();
      const headerCells = splitRow(line);
      out.push('<table><thead><tr>');
      for (const c of headerCells) out.push(`<th>${inline(c)}</th>`);
      out.push('</tr></thead><tbody>');
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        const cells = splitRow(lines[i]);
        out.push('<tr>');
        for (const c of cells) out.push(`<td>${inline(c)}</td>`);
        out.push('</tr>');
        i += 1;
      }
      out.push('</tbody></table>');
      continue;
    }

    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${inline(bullet[1])}</li>`);
      i += 1; continue;
    }

    closeList();
    out.push(`<p>${inline(line)}</p>`);
    i += 1;
  }
  closeList();
  return out.join('\n');
}

const STYLE = `
:root { color-scheme: dark; }
body { background: #0f1115; color: #e6e6e6; font: 15px/1.5 -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; padding: 24px 32px 64px; }
h1 { font-size: 1.5rem; border-bottom: 1px solid #2a2d34; padding-bottom: 8px; }
h2 { font-size: 1.15rem; margin-top: 2em; color: #9fd3ff; }
h3 { font-size: 1rem; color: #c9c9c9; }
p { color: #cfd3da; max-width: 100ch; }
code { background: #1c1f26; padding: 1px 5px; border-radius: 4px; color: #ffd479; }
ul { padding-left: 1.4em; }
li { margin: 3px 0; }
table { border-collapse: collapse; width: 100%; margin: 12px 0 20px; font-size: 0.92em; }
th, td { border: 1px solid #2a2d34; padding: 6px 10px; text-align: left; vertical-align: top; }
th { background: #171a20; color: #9fd3ff; position: sticky; top: 0; }
tr:nth-child(even) td { background: #14161c; }
`;

function renderHtmlDocument(md, title) {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
${markdownToHtml(md)}
</body>
</html>
`;
}

/** input .../rollups/2026-09-23.md -> wezbridge/artifacts/rollup-2026-09-23.html
 *  input .../rollups/retro-2026-W39.md -> wezbridge/artifacts/rollup-retro-2026-W39.html */
function defaultOutputPath(inputPath) {
  const base = path.basename(inputPath, path.extname(inputPath));
  return path.join(REPO, 'artifacts', `rollup-${base}.html`);
}

function renderRollupHtml(inputPath, outputPath) {
  const md = fs.readFileSync(inputPath, 'utf8');
  const out = outputPath || defaultOutputPath(inputPath);
  const title = path.basename(inputPath, path.extname(inputPath));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, renderHtmlDocument(md, `Rollup ${title}`));
  return out;
}

function main() {
  const [, , input, output] = process.argv;
  if (!input) {
    console.error('uso: node scripts/rollup-to-html.cjs <input.md> [output.html]');
    return 1;
  }
  try {
    const out = renderRollupHtml(input, output);
    console.log(`${new Date().toISOString()} rollup-to-html: ${out}`);
    return 0;
  } catch (err) {
    console.error(`rollup-to-html BROKE: ${err.stack || err.message}`);
    return 1;
  }
}

if (require.main === module) process.exit(main());
module.exports = { markdownToHtml, renderHtmlDocument, defaultOutputPath, renderRollupHtml };

#!/usr/bin/env node
/**
 * fleet-status — regenerable "who is doing what" view.
 *
 * Reads the fleet ledger (_intel/tasks/*.json) and LIVE pane state (wezterm cli),
 * writes a single self-contained HTML file. No agent, no narration, no memory.
 * Run it any time:  node scripts/fleet-status.cjs [--open]
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');           // Py Apps
const TASKS = path.join(ROOT, '_intel', 'tasks');
const OUT = path.join(__dirname, '..', 'artifacts', 'fleet-status.html');

// ---------- ledger ----------
function readTasks() {
  if (!fs.existsSync(TASKS)) return [];
  return fs.readdirSync(TASKS)
    .filter(f => f.endsWith('.json'))
    .map(f => { try { return JSON.parse(fs.readFileSync(path.join(TASKS, f), 'utf8')); } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

// ---------- live panes ----------
// Death signature: a pane sitting at a shell prompt with a `claude --resume <uuid>`
// line is a DEAD agent, not a working one. A pane-count check cannot tell them apart.
const DEAD = /claude --resume [0-9a-f-]{36}[\s\S]*\$\s*$/;

function livePanes() {
  // `wezterm cli list` intermittently ETIMEDOUTs when the mux is busy — 16 panes
  // each running test suites is enough to do it, and the very next call succeeds.
  // One transient timeout used to empty the whole live half of this page.
  let list;
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      list = JSON.parse(execFileSync('wezterm', ['cli', 'list', '--format', 'json'],
        { encoding: 'utf8', timeout: 20000 }));
      lastErr = null;
      break;
    } catch (e) {
      lastErr = String(e.message || e).split('\n')[0];
    }
  }
  if (lastErr) return { error: `${lastErr} (3 attempts)`, panes: [] };
  const panes = [];
  for (const p of list) {
    let tail = '';
    try {
      tail = execFileSync('wezterm', ['cli', 'get-text', '--pane-id', String(p.pane_id)],
        { encoding: 'utf8', timeout: 15000 });
    } catch { /* pane may have closed mid-scan */ }
    const lines = tail.split('\n').filter(l => l.trim()).slice(-6);
    const blob = lines.join('\n');
    const ctx = blob.match(/(\d+)k\/([\d.]+)M \((\d+)%\)/);
    panes.push({
      id: p.pane_id,
      title: (p.tab_title || p.title || '').trim(),
      cwd: decodeURIComponent(String(p.cwd || '')).replace(/^file:\/\/[^/]*/, ''),
      dead: DEAD.test(blob),
      ctxPct: ctx ? Number(ctx[3]) : null,
      tail: lines.slice(-3).join('\n'),
    });
  }
  return { error: null, panes };
}

// ---------- render ----------
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const proj = p => (p.cwd.split(/[\\/]/).filter(Boolean).pop() || '—');

function render(tasks, live) {
  const byState = {};
  for (const t of tasks) (byState[t.state] ||= []).push(t);
  const blocked = byState.blocked || [];
  const running = byState.running || [];
  const ready = byState.ready || [];

  const paneRows = live.panes.map(p => `
    <tr class="${p.dead ? 'dead' : ''}">
      <td class="mono">${p.id}</td>
      <td>${esc(proj(p))}</td>
      <td>${p.dead ? '<span class="tag t-dead">DEAD — agent exited</span>'
                   : '<span class="tag t-live">live</span>'}</td>
      <td>${p.ctxPct != null ? p.ctxPct + '%' : '<span class="dim">—</span>'}</td>
      <td class="task">${esc(p.title || '—')}</td>
    </tr>`).join('');

  // Full detail inline: the ledger JSON must never be the only place the operator can read a task.
  const detail = t => {
    const bits = [];
    if (t.goal) bits.push(`<div class="d-l">Goal</div><div class="d-v">${esc(t.goal)}</div>`);
    if (Array.isArray(t.acceptance_criteria) && t.acceptance_criteria.length)
      bits.push(`<div class="d-l">Acceptance</div><div class="d-v"><ul>${t.acceptance_criteria.map(c => `<li>${esc(c)}</li>`).join('')}</ul></div>`);
    if (t.next_action) bits.push(`<div class="d-l">Next action</div><div class="d-v">${esc(t.next_action)}</div>`);
    if (t.blocker) bits.push(`<div class="d-l">Blocker</div><div class="d-v">${esc(t.blocker)}</div>`);
    if (t.corr) bits.push(`<div class="d-l">Thread</div><div class="d-v mono">${esc(t.corr)}</div>`);
    const meta = [t.lease ? `leased: ${esc(JSON.stringify(t.lease))}` : null,
                  t.updated_at ? `updated ${esc(String(t.updated_at).slice(0, 16).replace('T', ' '))}Z` : null,
                  `attempt ${t.attempt ?? 1}`].filter(Boolean).join(' · ');
    bits.push(`<div class="d-l">Meta</div><div class="d-v dim">${meta}</div>`);
    return bits.join('');
  };

  // "ready" does NOT mean orphaned. Panes pick work up from A2A instructions without taking a
  // formal lease, so approved-and-queued work sits in `ready`. Show which live pane owns the repo
  // so the operator sees "waiting for pane N", not "nobody wants this".
  const ownerOf = repo => {
    if (!repo) return null;
    const p = live.panes.find(p => !p.dead && proj(p).toLowerCase() === String(repo).toLowerCase());
    return p ? p.id : null;
  };

  const taskRows = (arr, cls) => arr.map(t => {
    const owner = ownerOf(t.repo);
    const own = t.lease ? `<span class="tag t-run">leased</span>`
      : owner != null ? `<span class="tag t-queue">pane ${owner}</span>`
      : `<span class="tag t-none">no live pane</span>`;
    return `
    <tr>
      <td class="mono"><span class="tag ${cls}">${esc(t.id)}</span></td>
      <td>${esc(t.repo || '—')}${cls === 't-ready' ? '<br>' + own : ''}</td>
      <td>${esc(t.kind || '')}</td>
      <td class="task">
        <details><summary>${esc(t.title || '(no title)')}</summary>
          <div class="detail">${detail(t)}</div>
        </details>
      </td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="30">
<title>Fleet status</title><style>
:root{--bg:#0f1115;--panel:#161a21;--line:#2a313d;--fg:#e6e9ef;--dim:#9aa4b2;--faint:#6b7684;
--red:#ff6b6b;--amber:#ffb454;--green:#4ade80;--blue:#60a5fa;
--mono:ui-monospace,"Cascadia Code",Consolas,monospace}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);padding:0 0 60px;
font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:1120px;margin:0 auto;padding:0 22px}
header{border-bottom:1px solid var(--line);padding:30px 0 20px;margin-bottom:26px}
h1{margin:0 0 4px;font-size:25px;letter-spacing:-.02em}
h2{font-size:17px;margin:34px 0 10px;padding-bottom:7px;border-bottom:1px solid var(--line)}
.sub{color:var(--dim);font-size:13.5px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin:14px 0 6px}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:9px;padding:14px 16px}
.stat .n{font-size:28px;font-weight:650;letter-spacing:-.03em;line-height:1.1}
.stat .l{color:var(--dim);font-size:12px;margin-top:3px}
.scroll{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:13.5px;margin:8px 0 16px}
th{text-align:left;padding:7px 9px;border-bottom:1px solid var(--line);color:var(--faint);
font-size:11px;letter-spacing:.06em;text-transform:uppercase}
td{padding:8px 9px;border-bottom:1px solid #20262f;vertical-align:top}
td.task{color:var(--dim)}
tr.dead td{background:#241618}
.mono{font-family:var(--mono);font-size:12px}
.dim{color:var(--faint)}
.tag{display:inline-block;font-family:var(--mono);font-size:11px;padding:2px 6px;border-radius:4px;
border:1px solid;white-space:nowrap}
.t-dead{color:var(--red);border-color:#4a2626;background:#2a1a1a}
.t-live{color:var(--green);border-color:#1f4030;background:#15251d}
.t-block{color:var(--red);border-color:#4a2626;background:#2a1a1a}
.t-run{color:var(--green);border-color:#1f4030;background:#15251d}
.t-ready{color:var(--blue);border-color:#1e3a5a;background:#152130}
.t-queue{color:var(--amber);border-color:#4a3a1a;background:#2a2318}
.t-none{color:var(--faint);border-color:#2a313d;background:#1a1f26}
.warn{border-left:3px solid var(--amber);padding:10px 14px;background:#1c1a15;margin:14px 0;border-radius:0 8px 8px 0}
details summary{cursor:pointer;color:var(--dim);list-style:revert}
details summary:hover{color:var(--fg)}
details[open] summary{color:var(--fg);margin-bottom:8px}
.detail{display:grid;grid-template-columns:104px 1fr;gap:6px 14px;background:#12161d;
border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin:6px 0 10px;color:var(--fg)}
.d-l{color:var(--faint);font-size:11px;letter-spacing:.05em;text-transform:uppercase;padding-top:2px}
.d-v{font-size:13px;line-height:1.55;overflow-wrap:anywhere}
.d-v ul{margin:0;padding-left:17px}
footer{margin-top:40px;padding-top:16px;border-top:1px solid var(--line);color:var(--faint);font-size:12px}
</style></head><body><div class="wrap">
<header><h1>Fleet status</h1>
<div class="sub">generated ${new Date().toISOString().replace('T', ' ').slice(0, 16)}Z from <span class="mono">_intel/tasks/</span> + live wezterm panes — regenerate with <span class="mono">node scripts/fleet-status.cjs</span></div></header>

<div class="grid">
<div class="stat"><div class="n" style="color:var(--red)">${blocked.length}</div><div class="l">blocked on operator</div></div>
<div class="stat"><div class="n" style="color:var(--green)">${running.length}</div><div class="l">tasks running</div></div>
<div class="stat"><div class="n" style="color:var(--blue)">${ready.length}</div><div class="l">ready, unclaimed</div></div>
<div class="stat"><div class="n">${live.panes.length}</div><div class="l">panes${live.panes.filter(p => p.dead).length ? ` · <span style="color:var(--red)">${live.panes.filter(p => p.dead).length} dead</span>` : ''}</div></div>
</div>

${live.error ? `<div class="warn">Live pane scan failed: <span class="mono">${esc(live.error)}</span> — ledger figures below are still accurate.</div>` : ''}
${live.panes.some(p => p.dead) ? `<div class="warn"><b>Dead panes detected.</b> A pane showing <span class="mono">claude --resume &lt;uuid&gt;</span> at a shell prompt is an agent that exited — it still counts as a pane, so a pane-count check reports the fleet healthy.</div>` : ''}

${briefingHtml(readBriefing())}

<h2>Panes — who is doing what</h2>
<div class="scroll"><table>
<tr><th>Pane</th><th>Project</th><th>State</th><th>Ctx</th><th>Current task (tab title)</th></tr>
${paneRows || '<tr><td colspan="5" class="dim">no panes</td></tr>'}
</table></div>

<h2>Blocked on you — ${blocked.length}</h2>
<div class="scroll"><table>
<tr><th>ID</th><th>Repo</th><th>Kind</th><th>Decision</th></tr>
${taskRows(blocked, 't-block') || '<tr><td colspan="4" class="dim">none</td></tr>'}
</table></div>

<h2>Running — ${running.length}</h2>
<div class="scroll"><table>
<tr><th>ID</th><th>Repo</th><th>Kind</th><th>Task</th></tr>
${taskRows(running, 't-run') || '<tr><td colspan="4" class="dim">none</td></tr>'}
</table></div>

<h2>Approved &amp; queued — ${ready.length}</h2>
<p class="dim" style="font-size:13px;margin:0 0 6px">Unblocked and owned. Panes work these in sequence after their current task — they take no formal lease, so "queued" is inferred from which live pane owns the repo, not from the ledger.</p>
<div class="scroll"><table>
<tr><th>ID</th><th>Repo / owner</th><th>Kind</th><th>Task</th></tr>
${taskRows(ready, 't-ready') || '<tr><td colspan="4" class="dim">none</td></tr>'}
</table></div>

<footer>${tasks.length} ledger tasks · ${live.panes.length} panes scanned · this file is generated, never hand-edited</footer>
</div></body></html>`;
}

/**
 * Optional operator briefing rendered above the tables.
 * Lives in _intel/fleet-briefing.md so it survives regeneration — the HTML is
 * generated and must never be hand-edited, but the narrative is editorial and
 * cannot be derived from the ledger.
 */
function readBriefing() {
  const p = path.join(ROOT, '_intel', 'fleet-briefing.md');
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`briefing unreadable: ${err.message}`);
    return '';
  }
}

/** Minimal md subset: ## headings, - bullets, **bold**, `code`, blank-line paragraphs. */
function briefingHtml(md) {
  if (!md.trim()) return '';
  const inline = (s) => esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/`(.+?)`/g, '<span class="mono">$1</span>');
  const out = [];
  let inList = false;
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (/^##\s+/.test(line)) {
      if (inList) { out.push('</ul>'); inList = false; }
      out.push(`<h3 style="margin:16px 0 6px;font-size:14px">${inline(line.replace(/^##\s+/, ''))}</h3>`);
    } else if (/^-\s+/.test(line)) {
      if (!inList) { out.push('<ul style="margin:6px 0;padding-left:18px">'); inList = true; }
      out.push(`<li style="margin:3px 0">${inline(line.replace(/^-\s+/, ''))}</li>`);
    } else if (!line) {
      if (inList) { out.push('</ul>'); inList = false; }
    } else {
      if (inList) { out.push('</ul>'); inList = false; }
      out.push(`<p style="margin:6px 0">${inline(line)}</p>`);
    }
  }
  if (inList) out.push('</ul>');
  return `<h2>Briefing</h2><div class="detail" style="grid-template-columns:1fr;font-size:13px;line-height:1.6">${out.join('\n')}</div>`;
}

// ---------- main ----------
function generate() {
  const tasks = readTasks();
  const live = livePanes();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, render(tasks, live), 'utf8');
  return {
    tasks: tasks.length, panes: live.panes.length,
    dead: live.panes.filter(p => p.dead).length,
    // Carried so the CONSOLE can say "could not ask" instead of "0". Printing a
    // bare 0 for a scan that never ran is the same lie this fleet keeps finding:
    // a check that cannot see reports CLEAN rather than "I cannot see".
    error: live.error,
  };
}

const watchArg = process.argv.find(a => a.startsWith('--watch'));
const stamp = () => new Date().toISOString().slice(11, 19);

const first = generate();
console.log(`wrote ${OUT}`);
console.log(first.error
  ? `  ${first.tasks} tasks · PANE SCAN FAILED (${first.error}) — pane figures are UNKNOWN, not zero`
  : `  ${first.tasks} tasks · ${first.panes} panes · ${first.dead} dead`);

if (process.argv.includes('--open')) {
  // `cmd /c start` spawns a console here; explorer opens the default browser directly.
  try { execFileSync('explorer', [OUT]); } catch { /* explorer returns nonzero even on success */ }
}

if (watchArg) {
  // --watch[=seconds], default 30. The page carries a matching meta-refresh, so the
  // browser reloads on its own — no server, no websocket, nothing else to keep alive.
  const secs = Math.max(5, Number(watchArg.split('=')[1]) || 30);
  console.log(`watching — regenerating every ${secs}s (ctrl+c to stop)`);
  setInterval(() => {
    try {
      const r = generate();
      console.log(`${stamp()} ${r.tasks} tasks · ${r.panes} panes · ${r.dead} dead`);
    } catch (e) {
      console.log(`${stamp()} regenerate failed: ${String(e.message || e).split('\n')[0]}`);
    }
  }, secs * 1000);
}

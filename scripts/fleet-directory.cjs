#!/usr/bin/env node
'use strict';
/**
 * fleet-directory.cjs — generate "Py Apps/FLEET.md", the fleet routing index.
 *
 * Why this exists: this fleet runs full Claude/Codex sessions in panes rather than
 * subagents or persona files, and a pane that hits something outside its own project
 * has no way to learn that another pane owns it. On 2026-07-29 eleven of fourteen
 * live panes — including infra, marketing, frontendesigner and memorymaster — existed
 * in NO registry at all: no graph contract, absent from sweeper-config, invisible to
 * ClawTrol. Routing did not fail for lack of a document; there was no roster.
 *
 * THE SPLIT THIS FILE ENFORCES:
 *   facts     -> DERIVED here, every run (contracts, ledger counts, ClawTrol reach,
 *                whether a pane is live). Never hand-written, so it cannot rot.
 *   judgement -> HAND-WRITTEN in Py Apps/fleet/<project>.md frontmatter (what a pane
 *                owns, the symptoms that should route work to it, what to never ask).
 * They live in separate files on purpose. A generated file that humans edit gets its
 * edits destroyed on the next run, and then nobody trusts it again.
 *
 * NO PANE IDS ARE EVER WRITTEN. They renumber when panes close — the fleet's one
 * pre-existing cross-pane doc is titled "pane-8" for a pane that is now a different
 * number. The index records WHETHER a project has a live pane; callers resolve the id
 * with discover_sessions at use time.
 *
 * Usage:  node fleet-directory.cjs [--check]
 *         --check exits 1 if FLEET.md is out of date (for CI / the steward).
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.env.PY_APPS_ROOT
  || path.resolve(__dirname, '..', '..');
const FLEET_DIR = path.join(ROOT, 'fleet');
const OUT = path.join(ROOT, 'FLEET.md');

// ---------- hand-written layer ----------

/**
 * Minimal frontmatter reader: `key: value` and `key:` followed by `  - item` lists.
 * Deliberately not a YAML dependency — this repo ships zero deps, and the schema is
 * fixed by _TEMPLATE.md.
 */
function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const out = {};
  let key = null;
  for (const raw of m[1].split(/\r?\n/)) {
    const item = raw.match(/^\s+-\s+(.*)$/);
    if (item && key) { (out[key] = out[key] || []).push(item[1].trim()); continue; }
    const kv = raw.match(/^([a-z_]+):\s*(.*)$/i);
    if (!kv) continue;
    key = kv[1];
    out[key] = kv[2].trim() === '' ? [] : kv[2].trim();
  }
  return out;
}

function loadBriefs() {
  const briefs = new Map();
  let files = [];
  try { files = fs.readdirSync(FLEET_DIR); } catch { return briefs; }
  for (const f of files) {
    if (!f.endsWith('.md') || f.startsWith('_')) continue;
    let fm;
    try { fm = parseFrontmatter(fs.readFileSync(path.join(FLEET_DIR, f), 'utf8')); } catch { continue; }
    if (fm && fm.project) briefs.set(fm.project, { ...fm, file: `fleet/${f}` });
  }
  return briefs;
}

// ---------- derived layer ----------

function registeredRepos() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, '_docs-curation', 'sweeper-config.json'), 'utf8'));
    return new Map((cfg.repos || []).map((r) => [r.name, r.path]));
  } catch { return new Map(); }
}

/** Read ONLY the allowlist key. The env file holds secrets that must never be logged. */
function clawtrolProjects() {
  const p = process.env.WEZBRIDGE_CLAWTROL_ENV
    || path.join(require('node:os').homedir(), '.wezbridge', 'clawtrol.env');
  try {
    const line = fs.readFileSync(p, 'utf8').split('\n').find((l) => l.startsWith('CLAWTROL_PROJECTS='));
    return new Set((line || '').split('=')[1].split(',').map((s) => s.trim()).filter(Boolean));
  } catch { return new Set(); }
}

function contractOf(dirName, repoPath) {
  const rel = repoPath || dirName;
  try {
    const g = JSON.parse(fs.readFileSync(path.join(ROOT, rel, '.agent-workflow', 'graph.json'), 'utf8'));
    const kinds = Object.entries(g.kinds || {});
    return {
      ungated: kinds.filter(([, v]) => !v.gate).map(([k]) => k),
      gated: kinds.filter(([, v]) => v.gate === 'operator').map(([k]) => k),
    };
  } catch { return null; }
}

function ledgerCounts() {
  const dir = path.join(ROOT, '_intel', 'tasks');
  const counts = new Map();
  let files = [];
  try { files = fs.readdirSync(dir); } catch { return counts; }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const t = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (['done', 'cancelled'].includes(t.state)) continue;
      counts.set(t.repo, (counts.get(t.repo) || 0) + 1);
    } catch { /* skip */ }
  }
  return counts;
}

/**
 * Which projects currently have a pane, as a BOOLEAN. Asks the local daemon; if it is
 * down we say so rather than guessing, because "no pane" and "could not look" are very
 * different answers and conflating them is how a silent sensor failure starts.
 */
async function livePaneProjects() {
  try {
    const res = await fetch('http://127.0.0.1:4200/api/panes', { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    const body = await res.json();
    const list = Array.isArray(body) ? body : (body.panes || body.sessions || []);
    const found = new Set();
    for (const p of list) {
      // `project_name` is the SHELL's directory, which is not always where the agent
      // is working: the infra session runs in a pane whose shell sits at "Py Apps"
      // while the agent has moved into "Py Apps/infra", so project_name reported the
      // parent and infra looked like it had no pane at all. The status line states the
      // agent's own cwd, so prefer it — this reads a declared fact, not an inference.
      // The status line packs several fields onto one row and the separators are NOT
      // spaces: they are U+00A0 non-breaking spaces around Powerline glyphs in the
      // private-use area (U+E000–U+F8FF). Splitting on /\s{2,}/ therefore never fires —
      // the two nbsp are separated by a glyph that is not whitespace — and the captured
      // "path" came out as "infra<nbsp><glyph><nbsp>Reset: 4hr...", which failed every
      // directory lookup and reported infra as having no pane. A wrong answer that looks
      // exactly like a correct one. Cut on the glyph, then on any "Label:" field.
      const stated = String(p.last_line || '').match(/cwd:\s*(.+)/i);
      const statedPath = stated
        ? stated[1]
          .split(/[-]/)[0]
          .split(/[\s ]+[A-Z][A-Za-z]*:/)[0]
          .replace(/ /g, ' ')
          .trim()
        : null;
      const candidates = [statedPath, p.project_name, p.project]
        .filter(Boolean)
        .map((c) => String(c).trim().split(/[\\/]/).filter(Boolean).pop());
      for (const c of candidates) {
        if (c && isProjectDir(c)) { found.add(c); break; }
      }
    }
    return found;
  } catch { return null; }
}

/** A project is a real directory under the Py Apps root — this filters out panes
 *  sitting in a home directory or on the Desktop, mechanically and without judging
 *  which projects matter. */
function isProjectDir(name) {
  try { return fs.statSync(path.join(ROOT, name)).isDirectory(); } catch { return false; }
}

// ---------- compose ----------

function buildRows({ briefs, registered, claw, ledger, live }) {
  // Scope is MECHANICAL, never a judgement about which projects matter: a project is in
  // the index if any fleet mechanism already knows about it. The operator owns project
  // selection, so this must not rank, prune, or label anything as active or dead.
  const names = new Set([...briefs.keys(), ...registered.keys(), ...claw, ...ledger.keys()]);
  if (live) for (const n of live) names.add(n);
  // Drop anything that is not a real directory here — a pane parked in a home folder
  // or on the Desktop is not a project, and listing it as one invites a misroute.
  for (const n of [...names]) if (!isProjectDir(n)) names.delete(n);

  return [...names].sort((a, b) => a.localeCompare(b)).map((name) => {
    const b = briefs.get(name) || null;
    const contract = contractOf(name, registered.get(name));
    return {
      name,
      kind: b ? b.kind : null,
      owns: b ? b.owns : null,
      routeWhen: b && Array.isArray(b.route_here_when) ? b.route_here_when : [],
      briefFile: b ? b.file : null,
      pane: live ? live.has(name) : null,
      contract,
      open: ledger.get(name) || 0,
      claw: claw.has(name),
    };
  });
}

const yn = (v) => (v === null ? '?' : v ? 'yes' : '—');

function render(rows, { liveKnown, generatedAt }) {
  const withBrief = rows.filter((r) => r.briefFile);
  const withoutBrief = rows.filter((r) => !r.briefFile);
  const L = [];

  L.push('# FLEET — who owns what, and who you can hand work to');
  L.push('');
  L.push('> **GENERATED — do not edit.** Run `node wezbridge/scripts/fleet-directory.cjs` to refresh.');
  L.push('> Judgement lives in `fleet/<project>.md`; every fact below is derived at generation time.');
  L.push('> Generated ' + generatedAt + '.');
  L.push('');
  L.push('This fleet runs **full Claude/Codex sessions in panes**, not subagents or persona files.');
  L.push('A pane is a peer with its own context, its own project brain, and its own lifetime — so');
  L.push('handing work to one is delegation to a colleague, not spawning a helper. This file is the');
  L.push('roster that makes that possible: it tells you who exists, what they own, and what symptoms');
  L.push('mean the thing in front of you is somebody else\'s job.');
  L.push('');
  L.push('**Never store a pane ID.** They renumber when panes close. Resolve with');
  L.push('`discover_sessions` once per session, cache `{project -> pane_id}`, and refresh on');
  L.push('`session_removed` or `no such pane`. Send with `a2a_send` (it builds the envelope and');
  L.push('verifies submission); a `type=result` owes a `criteria:` block.');
  L.push('');
  L.push('## Two routing rules, both learned the hard way');
  L.push('');
  L.push('**1. Route by who OWNS the work, not by who is free.** On 2026-07-28 ClawTrol deployment');
  L.push('work — container promotion, a database role separation, deploy-path retirement — was sent');
  L.push('to a pane whose cwd is `argentina-sales-hub`, because it was an idle, capable session with');
  L.push('the right access. No files were harmed, and it still cost: that project\'s transcript is now');
  L.push('mostly another project\'s incident, its own `/goal` sat paused while it worked, and the');
  L.push('claims it ingested landed under a scope that does not match the session\'s project, which');
  L.push('fragments recall for both. If no pane owns the work, spawn one in the right cwd —');
  L.push('borrowing a pane because it is available is how a project\'s context gets spent on');
  L.push('somebody else\'s problem.');
  L.push('');
  L.push('**2. Route by the LEASE, not by the repo name.** A ledger task names a repo, but the pane');
  L.push('that owes you an answer is the one holding `lease.owner`. Sending a reconcile to the repo\'s');
  L.push('pane when another pane holds the lease means chasing the wrong agent — and a pane cannot');
  L.push('transition a task it does not hold, so it can only bounce it back.');
  L.push('');

  L.push('## Route by symptom');
  L.push('');
  L.push('If what you just hit appears here, it is not your job — hand it over.');
  L.push('');
  L.push('| you observe | hand to | live pane |');
  L.push('|---|---|---|');
  for (const r of withBrief) {
    for (const s of r.routeWhen) L.push(`| ${s} | **${r.name}** | ${yn(r.pane)} |`);
  }
  L.push('');

  L.push('## The roster');
  L.push('');
  L.push('| project | kind | owns | pane | contract | open tasks | on board |');
  L.push('|---|---|---|---|---|---|---|');
  for (const r of rows) {
    const c = r.contract
      ? `${r.contract.ungated.length} open / ${r.contract.gated.length} gated`
      : '—';
    L.push(`| ${r.briefFile ? `[${r.name}](${r.briefFile})` : r.name} | ${r.kind || '—'} | ${r.owns || '_no brief_'} | ${yn(r.pane)} | ${c} | ${r.open || '—'} | ${r.claw ? 'yes' : '—'} |`);
  }
  L.push('');
  L.push('`contract` = graph kinds in `.agent-workflow/graph.json`: how many an agent may act on');
  L.push('unaided, and how many are born blocked awaiting the operator. No contract means no');
  L.push('gates are enforced for that project — the ledger cannot refuse anything.');
  L.push('');
  L.push('`on board` = visible in ClawTrol. The allowlist is fail-closed: a project absent here');
  L.push('has its tasks silently withheld from the cockpit, however healthy it looks.');
  L.push('');

  // Coverage is stated, never implied. A roster that quietly omits half the fleet reads
  // as completeness — the same defect as a board showing "Needs Attention: 0".
  L.push('## What this index does NOT cover');
  L.push('');
  if (!liveKnown) {
    L.push('- **Live-pane column is `?` throughout**: the wezbridge daemon on :4200 did not answer,');
    L.push('  so presence could not be checked. That is "could not look", not "nobody home".');
  }
  if (withoutBrief.length) {
    L.push(`- **${withoutBrief.length} project(s) have no delegation brief**, so nothing routes to them by`);
    L.push('  symptom above. They appear in the roster because some fleet mechanism knows them:');
    L.push('  ' + withoutBrief.map((r) => `\`${r.name}\``).join(', '));
    L.push('  Add one by copying `fleet/_TEMPLATE.md`.');
  }
  const noContract = rows.filter((r) => !r.contract);
  if (noContract.length) {
    L.push(`- **${noContract.length} project(s) have no graph contract**, so the ledger enforces no operator`);
    L.push('  gate for them and any kind of work can be started unaided:');
    L.push('  ' + noContract.map((r) => `\`${r.name}\``).join(', '));
  }
  L.push('- **Projects outside every registry are absent entirely.** Inclusion here is mechanical —');
  L.push('  a brief, a ledger task, a contract, sweeper registration, or ClawTrol reach. It is not a');
  L.push('  judgement about which projects matter; the operator owns that.');
  L.push('');
  return L.join('\n');
}

async function main() {
  const [briefs, registered, claw, ledger] = [loadBriefs(), registeredRepos(), clawtrolProjects(), ledgerCounts()];
  const live = await livePaneProjects();
  const rows = buildRows({ briefs, registered, claw, ledger, live });
  const text = render(rows, { liveKnown: live !== null, generatedAt: new Date().toISOString() });

  if (process.argv.includes('--check')) {
    let current = '';
    try { current = fs.readFileSync(OUT, 'utf8'); } catch { /* missing */ }
    const strip = (s) => s.replace(/^> Generated .*$/m, '');
    const stale = strip(current) !== strip(text);
    process.stdout.write(stale ? 'FLEET.md is out of date — run without --check\n' : 'FLEET.md is current\n');
    process.exit(stale ? 1 : 0);
  }

  fs.writeFileSync(OUT, text);
  process.stdout.write(`wrote ${OUT}\n  ${rows.length} projects | ${rows.filter((r) => r.briefFile).length} with briefs`
    + ` | live-pane check: ${live ? 'ok' : 'UNAVAILABLE'}\n`);
}

module.exports = { parseFrontmatter, buildRows, render };

if (require.main === module) main().catch((e) => { process.stderr.write(`fleet-directory failed: ${e.message}\n`); process.exit(1); });

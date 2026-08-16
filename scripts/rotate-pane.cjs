#!/usr/bin/env node
'use strict';
/**
 * rotate-pane.cjs — free up a pane's context before giving it unrelated work.
 *
 * The operator's rule, verbatim: "if the next job is going to be unrelated, send
 * them a /compact or make them create their /handoff, grab it when they make it
 * and send a /clear + the handoff prompt".
 *
 * Why it matters: a pane at 86% context is past where quality degrades, and
 * handing it an unrelated task there wastes the budget twice — once carrying
 * dead context, once on the worse answer that context produces.
 *
 * THE ONE SAFETY PROPERTY, and everything else is detail:
 *
 *      NEVER SEND /clear UNLESS A HANDOFF FILE ACTUALLY APPEARED ON DISK.
 *
 * /clear is irreversible. A pane that was asked for a handoff and did not write
 * one — because it was busy, out of weekly budget, or simply ignored the ask —
 * still LOOKS identical to one that complied. Clearing on the assumption is how
 * a session's entire working state disappears with no record. So this waits for
 * a NEW file in the project's handoffs/ directory, and if none arrives it aborts
 * with the pane untouched. An aborted rotation costs a retry; a wrong one costs
 * the session.
 *
 *   node scripts/rotate-pane.cjs --tab-title brlite --project brlite --mode compact
 *   node scripts/rotate-pane.cjs --tab-title brlite --project brlite --mode handoff --next next-job.txt
 *   ... --dry-run       resolve and report, send nothing
 *
 * Exit: 0 rotated · 2 bad usage · 4 pane not reachable · 6 no handoff appeared
 *       (pane deliberately left INTACT) · 7 cleared but the follow-up failed
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HERE = __dirname;
const ROOT = path.join(HERE, '..', '..');

const arg = (n) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 ? process.argv[i + 1] : null;
};
const has = (n) => process.argv.includes(`--${n}`);
const log = (m) => console.log(`${new Date().toISOString()} rotate-pane: ${m}`);
const die = (code, m) => { log(`FAIL(${code}): ${m}`); process.exit(code); };

/** How long to wait for the pane to actually write its handoff. */
const HANDOFF_WAIT_MS = Number(process.env.WEZBRIDGE_HANDOFF_WAIT_MS) || 10 * 60000;
const POLL_MS = Number(process.env.WEZBRIDGE_ROTATE_POLL_MS) || 5000;
/** Let /clear settle before the next prompt, or it lands in a dying composer. */
const CLEAR_SETTLE_MS = Number(process.env.WEZBRIDGE_CLEAR_SETTLE_MS) || 4000;

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Every send goes through poke-pane, which verifies the composer cleared.
 *
 * WEZBRIDGE_ROTATE_FAKE_SEND exists so the /clear interlock below can be proven
 * without spending a real pane's session on it. The safety property here is one
 * an untested branch has no business carrying: this seam is the only way to
 * exercise "no handoff appeared" without asking a live agent for a handoff it
 * must then not produce. Records what it would have sent, so the test can assert
 * that /clear was never among them.
 */
function send(target, text, { dryRun }) {
  if (process.env.WEZBRIDGE_ROTATE_FAKE_SEND) {
    fs.appendFileSync(process.env.WEZBRIDGE_ROTATE_FAKE_SEND, `${text.split('\n')[0]}\n`);
    return { code: 0, out: 'fake' };
  }
  const tmp = path.join(require('node:os').tmpdir(), `rotate-${Date.now()}-${Math.floor(process.hrtime()[1] / 1000)}.txt`);
  fs.writeFileSync(tmp, text);
  const args = [path.join(HERE, 'poke-pane.cjs'), '--file', tmp];
  if (target.tabTitle) args.push('--tab-title', target.tabTitle);
  if (target.project) args.push('--project', target.project);
  if (dryRun) args.push('--dry-run');
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 120000 });
  try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  return { code: r.error ? 3 : r.status, out: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}

const handoffFiles = (dir) => {
  try { return new Set(fs.readdirSync(dir).filter((f) => f.endsWith('.md'))); } catch { return new Set(); }
};

function main() {
  const tabTitle = arg('tab-title');
  const project = arg('project');
  const mode = arg('mode') || 'compact';
  const nextFile = arg('next');
  const dryRun = has('dry-run');
  if (!tabTitle && !project) die(2, 'usage: --tab-title <t> and/or --project <p> [--mode compact|handoff] [--next <file>]');
  if (!['compact', 'handoff'].includes(mode)) die(2, `unknown mode "${mode}" - use compact or handoff`);

  const target = { tabTitle, project };
  const next = nextFile ? fs.readFileSync(nextFile, 'utf8').trim() : null;

  // ---- compact: cheap, keeps the session, no interlock needed ----
  if (mode === 'compact') {
    const hint = next ? ` Focus on what is still unfinished; the next job is unrelated.` : '';
    const r = send(target, `/compact${hint}`, { dryRun });
    if (r.code !== 0) die(4, `could not deliver /compact (poke-pane exit ${r.code}): ${r.out.slice(0, 120)}`);
    log(`sent /compact${dryRun ? ' (dry run)' : ''}`);
    if (next && !dryRun) {
      sleep(CLEAR_SETTLE_MS);
      const f = send(target, next, { dryRun });
      if (f.code !== 0) die(7, `compacted, but the follow-up job did not deliver (exit ${f.code})`);
      log('follow-up job delivered');
    }
    return 0;
  }

  // ---- handoff: the interlocked path ----
  const projDir = project ? path.join(ROOT, project) : null;
  if (!projDir || !fs.existsSync(projDir)) die(2, `--mode handoff needs a --project that resolves to a directory (got ${projDir})`);
  const hDir = path.join(projDir, 'handoffs');
  const before = handoffFiles(hDir);
  log(`${before.size} existing handoff file(s) in ${hDir}`);

  const ask = send(target, '/handoff', { dryRun });
  if (ask.code !== 0) die(4, `could not deliver /handoff (poke-pane exit ${ask.code}): ${ask.out.slice(0, 120)}`);
  if (dryRun) { log('dry run: would now wait for a new handoff file, then /clear, then send the next job'); return 0; }
  log('asked for a handoff, waiting for the file to appear');

  const deadline = Date.now() + HANDOFF_WAIT_MS;
  let fresh = null;
  while (Date.now() < deadline) {
    sleep(POLL_MS);
    const now = [...handoffFiles(hDir)].filter((f) => !before.has(f));
    if (now.length) { fresh = now.sort().at(-1); break; }
  }

  if (!fresh) {
    // THE INTERLOCK. No file means we cannot distinguish "wrote it" from "never
    // heard us" — and a pane at its weekly limit genuinely cannot comply. Leave
    // it exactly as it was.
    const waited = HANDOFF_WAIT_MS < 60000
      ? `${Math.round(HANDOFF_WAIT_MS / 1000)}s`
      : `${Math.round(HANDOFF_WAIT_MS / 60000)}min`;
    die(6, `no handoff appeared within ${waited}. NOT sending /clear - the pane is untouched and its context intact. Retry later, or use --mode compact.`);
  }
  log(`handoff written: ${fresh}`);

  const cleared = send(target, '/clear', {});
  if (cleared.code !== 0) die(4, `handoff exists at ${fresh} but /clear did not deliver (exit ${cleared.code}) - nothing was lost`);
  sleep(CLEAR_SETTLE_MS);

  const rel = path.join(project, 'handoffs', fresh).replace(/\\/g, '/');
  const resume = `Read \`${rel}\` first - it is your own handoff from the session that just ended, written because this pane was rotated to free context.\n\n${next || 'Then wait for instructions.'}`;
  const r = send(target, resume, {});
  if (r.code !== 0) die(7, `cleared and handoff is at ${rel}, but the resume prompt did not deliver (exit ${r.code}). Send it by hand.`);

  log(`rotated: handoff ${fresh} -> /clear -> resume prompt delivered`);
  return 0;
}

if (require.main === module) process.exit(main());
module.exports = { HANDOFF_WAIT_MS };

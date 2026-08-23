'use strict';
/**
 * observability.cjs — the six new windows the operator asked for on the night of
 * 2026-08-22: bots Hermes, colas por proyecto, acciones firmadas, rollup del día,
 * waker/motor, y census de scheduled tasks.
 *
 * SAME LAW AS THE REST OF THE BOARD. No model in any path. No state of its own.
 * Every number is derived from a file the fleet already writes, and every source
 * carries its OWN `generated_at` plus its OWN `error` — because six sources behind
 * one timestamp is the calm lie this fleet keeps re-finding: five panels fresh,
 * one dead, and a single green header covering for it. A source that cannot be
 * read says so IN ITS OWN PANEL and the other five keep working.
 *
 * ONE HARD RULE ABOUT COST. `/api/state` is polled every 15 s. `schtasks /query`
 * is a subprocess that daily-rollup gives a 60 s timeout, and spawnSync would
 * freeze the whole server for that long, four times a minute. So the census is
 * the only source here that is CACHED and ASYNC: a request never waits for it,
 * it reports `pending` on the first poll and real data on the next. Every other
 * source is small synchronous file reading.
 *
 * WHERE LOGIC IS BORROWED, IT IS IMPORTED, NEVER RE-TYPED. The schtasks CSV
 * quirk, the silent-failure classifier and the local-day window all live in
 * scripts/daily-rollup.cjs; the wake classifier lives in
 * scripts/orchestrator-turn.cjs. This file calls them. Re-implementing any of
 * them is how routine-findings got three divergent copies and two identical bugs
 * (see the comment on routineRuns() in server.cjs).
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const {
  parseSchtasksCsv, summarizeCensus, reportDateFor, localDateOf,
} = require(path.join(__dirname, '..', '..', 'scripts', 'daily-rollup.cjs'));

/** The two briefs the operator named. Order is the order they render in. */
const BRIEF_FILES = [
  { key: 'centinela', file: 'centinela-mas-reciente.md', label: 'Centinela (alertas del control-plane)' },
  { key: 'sensor', file: 'hermes-fleet-sensor-latest.md', label: 'Sensor de flota (hermes local, sin tokens)' },
];

const HERMES_CRON_DIR = process.env.WEZBRIDGE_HERMES_CRON_DIR
  || path.join(process.env.LOCALAPPDATA || '', 'hermes', 'cron');

const ACTIONS_TAIL = 50;
const TURNS_TAIL = 60;
const CRON_RUNS_TAIL = 20;
const BRIEF_CHAR_CAP = 8000;

const nowIso = (now) => new Date(now).toISOString();

/** A source that blew up reports the failure instead of vanishing. */
function failed(now, e) {
  return { generated_at: nowIso(now), error: String((e && e.message) || e).slice(0, 200) };
}

function readJsonlTail(file, max) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  return lines.slice(-max)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// ---------------------------------------------------------------------------
// PURE — waker turn classes
// ---------------------------------------------------------------------------

/**
 * Which wake class a turn's REASON string belongs to.
 *
 * Why this exists at all: `classifyWake()` writes `classes` alongside `reasons`,
 * but every turn record on disk right now carries `reasons` and no `classes` —
 * the field is newer than the 91 turns already written. A histogram that only
 * counted the new field would render an empty panel over a year of real data and
 * call it "sin datos", which is exactly the view-narrower-than-its-subject
 * defect. So `classes` wins when present and this back-fills when it is not.
 *
 * The mapping is not guessed: it is the inverse of the reason strings
 * classifyWake() emits, and `test/board-observability.test.cjs` generates those
 * strings THROUGH classifyWake so the two can never drift apart silently.
 */
function classOfReason(reason) {
  const r = String(reason || '');
  if (/^gate RED/.test(r)) return 'real-stall';
  if (/^gate UNKNOWN/.test(r)) return 'exception';
  if (/^gate exited/.test(r)) return 'exception';
  if (/in review with finished work/.test(r)) return 'results-directed';
  if (/completed work to harvest$/.test(r)) return 'results-directed';
  if (/pane blocked at a real gate$/.test(r)) return 'exception';
  return 'noise';
}

/** Classes for one turn record: the written field, else derived from reasons. */
function classesOfTurn(turn) {
  if (Array.isArray(turn && turn.classes) && turn.classes.length) return turn.classes;
  return (Array.isArray(turn && turn.reasons) ? turn.reasons : []).map(classOfReason);
}

const WAKE_CLASSES = ['results-directed', 'real-stall', 'exception', 'noise'];

/**
 * The motor's own report card. `woke` vs `skipped` is the number that matters:
 * a skip is the $0 classifier deciding nothing needed a model, which is the loop
 * WORKING, not a turn lost. Both are shown so neither can be mistaken for the
 * other.
 */
function summarizeWakerTurns(turns, now = Date.now()) {
  const sorted = [...(turns || [])].sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const classes = Object.fromEntries(WAKE_CLASSES.map((c) => [c, 0]));
  const actions = {};
  let woke = 0;
  for (const t of sorted) {
    if (t.woke) woke += 1;
    actions[t.action || 'none'] = (actions[t.action || 'none'] || 0) + 1;
    for (const c of classesOfTurn(t)) {
      if (c in classes) classes[c] += 1;
    }
  }
  const last = sorted[sorted.length - 1] || null;
  const lastAt = last ? Date.parse(last.at) : NaN;
  return {
    total: sorted.length,
    woke,
    skipped: sorted.length - woke,
    classes,
    actions,
    last_turn_at: Number.isFinite(lastAt) ? new Date(lastAt).toISOString() : null,
    last_turn_age_minutes: Number.isFinite(lastAt) ? Math.round((now - lastAt) / 60000) : null,
    last_reasons: (last && Array.isArray(last.reasons) ? last.reasons : []).slice(0, 4),
  };
}

// ---------------------------------------------------------------------------
// PURE — queues
// ---------------------------------------------------------------------------

/**
 * One project's queue file. A record counts as UNDELIVERED unless it says
 * plainly that it landed: `ok === true`. `delivered` alone is not enough —
 * on 2026-08-22 both live queues held records with an `actions.jsonl`
 * `queue_deliver` line and `delivered: null, ok: false` still on disk, and the
 * centinela had to report that inconsistency by hand. The durable record wins;
 * an optimistic read here would hide precisely the stuck queue this panel is for.
 */
function summarizeQueueRecords(records, now = Date.now()) {
  let undelivered = 0;
  let oldestAt = null;
  for (const r of records || []) {
    if (r && r.ok === true) continue;
    undelivered += 1;
    const t = Date.parse((r && r.time) || '');
    if (Number.isFinite(t) && (oldestAt === null || t < oldestAt)) oldestAt = t;
  }
  return {
    total: (records || []).length,
    delivered: (records || []).length - undelivered,
    undelivered,
    oldest_undelivered_at: oldestAt === null ? null : new Date(oldestAt).toISOString(),
    oldest_undelivered_minutes: oldestAt === null ? null : Math.round((now - oldestAt) / 60000),
  };
}

// ---------------------------------------------------------------------------
// PURE — rollup del día
// ---------------------------------------------------------------------------

const ROLLUP_HOUR_LOCAL = '02:30';

/**
 * Which rollup is current, and whether today's has run.
 *
 * THE WHOLE POINT IS THE TIMEZONE. The rollup covers the operator's LOCAL day
 * and its filename is that local date, but every timestamp inside it is UTC —
 * the operator has been bitten by this repeatedly, reading a "2026-08-22" file
 * stamped `2026-08-23T03:23Z` and concluding it was tomorrow's. So the expected
 * day comes from daily-rollup's OWN `reportDateFor` (the 02:30 run closes
 * YESTERDAY), and the panel says in words when the next run is due.
 */
function rollupStatus(files, now = new Date()) {
  const dates = (files || [])
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .sort();
  const newest = dates.length ? dates[dates.length - 1] : null;
  const newestDate = newest ? newest.replace(/\.md$/, '') : null;
  const expected = reportDateFor(now);
  return {
    newest,
    newest_date: newestDate,
    expected,
    // "Ran" means the file for the day the 02:30 job would be closing exists.
    // Compare DATES, not filenames: `2026-08-22.md !== 2026-08-22` is how the
    // first cut of this reported "todavía no corrió" over a rollup sitting
    // right there on disk.
    ran: newestDate === expected,
    today_local: localDateOf(now),
    next_run_local: ROLLUP_HOUR_LOCAL,
  };
}

// ---------------------------------------------------------------------------
// IO — one function per source, each fail-soft on its own
// ---------------------------------------------------------------------------

/** Bots Hermes, half 1: the two briefs, as raw markdown plus their mtime. */
function readBriefs(intelDir, now = Date.now()) {
  try {
    const items = BRIEF_FILES.map(({ key, file, label }) => {
      const full = path.join(intelDir, 'briefs', file);
      try {
        const stat = fs.statSync(full);
        const text = fs.readFileSync(full, 'utf8');
        return {
          key,
          label,
          file,
          last_run_at: new Date(stat.mtimeMs).toISOString(),
          text: text.slice(0, BRIEF_CHAR_CAP),
          truncated: text.length > BRIEF_CHAR_CAP,
        };
      } catch (e) {
        // Absent is NOT an error for these two: hermes-fleet-sensor-latest.md
        // literally documents "vacío de alertas = este archivo sólo existe si
        // algo estuvo mal alguna vez". A missing sensor brief is good news and
        // must not paint the panel red.
        return { key, label, file, last_run_at: null, text: null, missing: true, reason: e.code || 'ENOENT' };
      }
    });
    return { generated_at: nowIso(now), items };
  } catch (e) {
    return failed(now, e);
  }
}

/**
 * Bots Hermes, half 2: the cron ticker.
 *
 * `jobs.json` is the schedule and last verdict; `executions.db` is the run
 * history. The db was measured at 7 ms read-only with no lock contention
 * (2026-08-23, 56 rows), so it is read — but read-only, tail-capped, and inside
 * its own try: if it ever DOES fight the ticker's lock, this degrades to the
 * jobs.json half plus a pointer to `hermes cron runs`, and nothing above it
 * fails.
 */
function readHermesCron(dir = HERMES_CRON_DIR, now = Date.now()) {
  const out = { generated_at: nowIso(now), jobs: [], runs: null, runs_hint: 'hermes cron runs' };
  try {
    const doc = readJson(path.join(dir, 'jobs.json'));
    out.jobs = (doc.jobs || []).map((j) => ({
      id: j.id,
      name: j.name,
      schedule: j.schedule_display || (j.schedule && j.schedule.display) || '?',
      enabled: j.enabled !== false,
      state: j.state || '?',
      last_run_at: j.last_run_at || null,
      next_run_at: j.next_run_at || null,
      last_status: j.last_status || null,
      last_error: j.last_error || null,
      failure_streak: j.failure_streak || 0,
      completed: (j.repeat && j.repeat.completed) || 0,
    }));
    out.jobs_updated_at = doc.updated_at || null;
  } catch (e) {
    out.error = `jobs.json: ${String(e.message || e).slice(0, 160)}`;
  }
  try {
    // Lazily required: node:sqlite is experimental and prints a warning on
    // load, so it is only paid for when this panel is actually read.
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(dir, 'executions.db'), { readOnly: true });
    try {
      out.runs = db.prepare(
        'select job_id, status, started_at, finished_at, error from executions order by id desc limit ?',
      ).all(CRON_RUNS_TAIL);
    } finally {
      db.close();
    }
  } catch (e) {
    // Deliberately NOT an error on the panel: the pointer is the fallback the
    // operator was promised.
    out.runs = null;
    out.runs_error = String(e.message || e).slice(0, 160);
  }
  return out;
}

/** Colas por proyecto, plus the waker's flag files. */
function readQueues(intelDir, now = Date.now()) {
  try {
    const dir = path.join(intelDir, 'queues');
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { files = []; }
    const projects = files.map((f) => {
      const project = f.replace(/\.jsonl$/, '');
      try {
        const records = readJsonlTail(path.join(dir, f), 500);
        return { project, ...summarizeQueueRecords(records, now) };
      } catch (e) {
        return { project, error: String(e.message || e).slice(0, 120) };
      }
    }).sort((a, b) => (b.undelivered || 0) - (a.undelivered || 0));

    const flagsDir = path.join(intelDir, '.orch-waker-state');
    const readCount = (name) => {
      try {
        const v = readJson(path.join(flagsDir, name));
        return Array.isArray(v) ? v.length : Object.keys(v || {}).length;
      } catch { return null; }
    };
    return {
      generated_at: nowIso(now),
      projects,
      flags: readCount('flags.json'),
      pending: readCount('pending.json'),
      total_undelivered: projects.reduce((n, p) => n + (p.undelivered || 0), 0),
    };
  } catch (e) {
    return failed(now, e);
  }
}

/**
 * Acciones firmadas: the tail of actions.jsonl, newest first.
 *
 * This is the "quién hizo qué y por qué" the operator asked to have in front of
 * him. Every field is passed through as written — the log is signed by the actor
 * that appended it, and a board that paraphrased it would be a second source of
 * truth. `extra` is kept but flattened to a short string so a row stays a row.
 */
function readActions(intelDir, now = Date.now(), max = ACTIONS_TAIL) {
  try {
    const rows = readJsonlTail(path.join(intelDir, 'actions.jsonl'), max)
      .map((a) => ({
        at: a.ts || null,
        actor: a.actor || '?',
        action: a.action || '?',
        target: a.target || '',
        why: a.why || '',
        extra: a.extra && typeof a.extra === 'object'
          ? Object.entries(a.extra).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ')
          : '',
      }))
      .reverse();
    return { generated_at: nowIso(now), items: rows, count: rows.length };
  } catch (e) {
    return failed(now, e);
  }
}

/** Rollup del día: the newest file rendered, or an honest "todavía no corrió". */
function readRollup(intelDir, now = Date.now()) {
  try {
    const dir = path.join(intelDir, 'rollups');
    let files = [];
    try { files = fs.readdirSync(dir); } catch { files = []; }
    const status = rollupStatus(files, new Date(now));
    const out = { generated_at: nowIso(now), ...status, text: null, file_at: null };
    if (status.newest) {
      const full = path.join(dir, status.newest);
      const text = fs.readFileSync(full, 'utf8');
      out.text = text.slice(0, BRIEF_CHAR_CAP);
      out.truncated = text.length > BRIEF_CHAR_CAP;
      out.file_at = new Date(fs.statSync(full).mtimeMs).toISOString();
    }
    return out;
  } catch (e) {
    return failed(now, e);
  }
}

/** Waker/motor: the turn tail, classified. */
function readWaker(intelDir, now = Date.now()) {
  try {
    const dir = path.join(intelDir, 'turns');
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.startsWith('turn-') && f.endsWith('.json')).sort();
    } catch { files = []; }
    const turns = files.slice(-TURNS_TAIL).map((f) => {
      try { return readJson(path.join(dir, f)); } catch { return null; }
    }).filter(Boolean);
    return {
      generated_at: nowIso(now),
      window: turns.length,
      ...summarizeWakerTurns(turns, now),
    };
  } catch (e) {
    return failed(now, e);
  }
}

// ---------------------------------------------------------------------------
// Census de scheduled tasks — the ONE async, cached source
// ---------------------------------------------------------------------------

/** `schtasks /query /v /fo csv` as a promise. Never throws; resolves to text. */
function runSchtasks({ timeoutMs = 45000 } = {}) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, arg) => { if (!done) { done = true; fn(arg); } };
    let out = '';
    let child;
    try {
      child = spawn('schtasks', ['/query', '/v', '/fo', 'csv'], { windowsHide: true });
    } catch (e) { return reject(e); }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } finish(reject, new Error('schtasks timeout')); }, timeoutMs);
    child.stdout.on('data', (c) => { out += c.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(timer); finish(reject, e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return finish(reject, new Error(`schtasks exited ${code}`));
      return finish(resolve, out);
    });
    return undefined;
  });
}

/**
 * TTL cache that NEVER blocks a request.
 *
 * `get()` returns whatever is currently known and kicks off a refresh in the
 * background when the value is stale. The first call therefore reports
 * `status: 'pending'` — an honest "todavía no leí" that the UI shows as a
 * loading state — and the poll 15 s later has real rows. A cache that made the
 * caller wait would put a subprocess on the critical path of a 15-second poll,
 * which is the whole reason this is not just a spawnSync.
 */
function makeCensusCache({ ttlMs = 5 * 60 * 1000, run = runSchtasks } = {}) {
  let value = { status: 'pending', generated_at: null, items: [], silent: [] };
  let at = 0;
  let inflight = null;

  function refresh(now) {
    inflight = run()
      .then((text) => {
        const { items, silent } = summarizeCensus(parseSchtasksCsv(text));
        value = { status: 'ok', generated_at: nowIso(Date.now()), items, silent };
      })
      .catch((e) => {
        value = {
          status: 'error', generated_at: nowIso(Date.now()), items: [], silent: [],
          error: String(e.message || e).slice(0, 200),
        };
      })
      .finally(() => { inflight = null; at = Date.now(); });
    at = now;
    return inflight;
  }

  return {
    get(now = Date.now()) {
      if (!inflight && (at === 0 || now - at > ttlMs)) refresh(now);
      return value;
    },
    /** Tests only: await the in-flight refresh instead of racing it. */
    settled: () => inflight || Promise.resolve(),
  };
}

// ---------------------------------------------------------------------------
// The whole block, as /api/state carries it
// ---------------------------------------------------------------------------

/**
 * Every source is read INDEPENDENTLY and each one owns its failure. There is
 * deliberately no try around the whole thing that could return one error for
 * six panels: the operator must be able to see that the queues are fine while
 * the census is broken.
 */
function buildObservability(intelDir, { now = Date.now(), censusCache, hermesDir = HERMES_CRON_DIR } = {}) {
  return {
    generated_at: nowIso(now),
    briefs: readBriefs(intelDir, now),
    hermes_cron: (() => { try { return readHermesCron(hermesDir, now); } catch (e) { return failed(now, e); } })(),
    queues: readQueues(intelDir, now),
    actions: readActions(intelDir, now),
    rollup: readRollup(intelDir, now),
    waker: readWaker(intelDir, now),
    census: censusCache ? censusCache.get(now) : { status: 'disabled', items: [], silent: [] },
  };
}

module.exports = {
  buildObservability,
  classOfReason, classesOfTurn, summarizeWakerTurns, WAKE_CLASSES,
  summarizeQueueRecords, rollupStatus,
  readBriefs, readHermesCron, readQueues, readActions, readRollup, readWaker,
  makeCensusCache, runSchtasks,
  BRIEF_FILES, ACTIONS_TAIL, HERMES_CRON_DIR,
};

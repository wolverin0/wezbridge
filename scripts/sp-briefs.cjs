'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');

const BOTS = Object.freeze(['centinela', 'dep-scout', 'wabot-curador', 'auditor-ronda', 'skill-curator']);
const PROJECT = 'Avisos';

function readBriefs(intel) {
  return BOTS.map(bot => {
    const file = path.join(intel, 'briefs', `${bot}-mas-reciente.md`);
    const bytes = fs.readFileSync(file);
    if (!bytes.length || bytes.length > 256 * 1024) throw Error(`brief ${bot}: empty or exceeds 256 KiB`);
    const sha = createHash('sha256').update(bytes).digest('hex');
    return { bot, sha, key: `${bot}:${sha}`, marker: `[ext:brief:${bot}:${sha}]`,
      link: pathToFileURL(path.resolve(file)).href, text: bytes.toString('utf8') };
  });
}
function readState(file) {
  let state;
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (err) { if (err.code === 'ENOENT') return { active: {}, revisions: {}, pending: null }; throw err; }
  const validId = id => typeof id === 'string' && id.length > 0;
  const validBrief = b => b && BOTS.includes(b.bot) && /^[a-f0-9]{64}$/.test(b.sha) && b.key === `${b.bot}:${b.sha}`;
  if (!state || [state.active, state.revisions].some(x => !x || typeof x !== 'object' || Array.isArray(x))
    || Object.entries(state.active).some(([bot, b]) => !validBrief({ ...b, bot, key: `${bot}:${b?.sha}` }) || !validId(b.taskId))
    || Object.entries(state.revisions).some(([key, id]) => !validBrief({ bot: key.split(':')[0], sha: key.split(':')[1], key }) || !validId(id))
    || (state.pending && (!validBrief(state.pending) || (state.pending.taskId !== undefined && !validId(state.pending.taskId))))) {
    throw Error('invalid briefs state; preserve it for reconciliation');
  }
  return state;
}
function writeState(file, state) {
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeFileSync(fd, JSON.stringify(state, null, 2)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}
function findTask(tasks, brief, projectId) {
  const matches = tasks.filter(t => t.projectId === projectId && String(t.notes || '').split(/\r?\n/).includes(brief.marker));
  if (matches.length > 1) throw Error(`ambiguous SP tasks for ${brief.bot} SHA ${brief.sha}; reconcile manually`);
  return matches[0]?.id || null;
}
function taskData(brief, projectId, tagId) {
  return { title: `${brief.bot}: brief ${brief.sha.slice(0, 12)}`, projectId, tagIds: [tagId],
    notes: `Brief: [Abrir archivo](${brief.link})\nArchivo: _intel/briefs/${brief.bot}-mas-reciente.md\nSHA-256: ${brief.sha}\n\n${brief.text}\n\n${brief.marker}`,
    plannedAt: null, dueDay: null };
}

async function syncOne(brief, ctx) {
  const { client, stateFile, projectId, tagId } = ctx;
  let state = readState(stateFile);
  const previous = state.active[brief.bot];
  if (previous?.sha === brief.sha && !state.pending) return { ...briefResult(brief, previous.taskId), unchanged: true };
  if (previous && findTask(ctx.tasks, { ...brief, sha: previous.sha,
    marker: `[ext:brief:${brief.bot}:${previous.sha}]` }, projectId) !== previous.taskId) {
    throw Error(`predecessor ownership mismatch for ${brief.bot}; refusing completion`);
  }
  if (state.pending && state.pending.key !== brief.key) throw Error('pending brief changed; reconcile before sending a different revision');
  let taskId = state.revisions[brief.key] || state.pending?.taskId || findTask(ctx.tasks, brief, projectId);
  if (taskId && findTask(ctx.tasks, brief, projectId) !== taskId) throw Error(`revision ownership mismatch for ${brief.bot}`);
  const recovered = Boolean(taskId && !state.revisions[brief.key]);
  let created = false;
  if (!taskId) {
    if (state.pending) throw Error(`uncertain addTask for ${brief.bot}; no matching marker yet, manual reconciliation required`);
    state = { ...state, pending: { key: brief.key, bot: brief.bot, sha: brief.sha } };
    writeState(stateFile, state); // Commit intent BEFORE a potentially ambiguous plugin response.
    taskId = await client.addTask(taskData(brief, projectId, tagId));
    if (typeof taskId !== 'string' || !taskId) throw Error('addTask did not return a task id; reconcile pending intent');
    created = true;
  }
  state = { ...state, pending: { key: brief.key, bot: brief.bot, sha: brief.sha, taskId } };
  writeState(stateFile, state);
  const completed = Boolean(previous && previous.taskId !== taskId);
  if (completed) await client.setTaskDone(previous.taskId);
  writeState(stateFile, { ...state, pending: null,
    active: { ...state.active, [brief.bot]: { sha: brief.sha, taskId } },
    revisions: { ...state.revisions, [brief.key]: taskId } });
  return { ...briefResult(brief, taskId), created, completed, recovered };
}
function briefResult(brief, taskId) {
  return { bot: brief.bot, sha: brief.sha, taskId, link: brief.link };
}

async function syncBriefs({ client, intel, ensureProject, ensureTag }) {
  const dir = path.join(intel, '.sp-bridge');
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, 'briefs.lock');
  const fd = fs.openSync(lock, 'wx');
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    const briefs = readBriefs(intel);
    const stateFile = path.join(dir, 'briefs.json');
    const state = readState(stateFile);
    if (state.pending && !briefs.some(b => b.key === state.pending.key)) throw Error('pending brief source changed; manual reconciliation required');
    // Resume the uncertain/completion-pending bot first, even if it is not first in the roster.
    const ordered = state.pending ? [...briefs.filter(b => b.key === state.pending.key), ...briefs.filter(b => b.key !== state.pending.key)] : briefs;
    const projectId = await ensureProject(PROJECT);
    const tagId = await ensureTag('agente');
    const tasks = await client.getTasks({ projectId, includeDone: true, includeArchived: true });
    const items = [];
    for (const brief of ordered) items.push(await syncOne(brief, { client, stateFile, projectId, tagId, tasks }));
    const summary = { created: items.filter(x => x.created).length, completed: items.filter(x => x.completed).length,
      unchanged: items.filter(x => x.unchanged).length, recovered: items.filter(x => x.recovered).length };
    writeState(stateFile, { ...readState(stateFile), ts: new Date().toISOString(), last_run: summary });
    return { ...summary, items };
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}

module.exports = { BOTS, PROJECT, syncBriefs };

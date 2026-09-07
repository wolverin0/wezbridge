'use strict';
// Passive reader for declared routines, including bots that have never emitted a run.
const fs = require('node:fs');
const path = require('node:path');
const HOUR = 3600000;

function filesIn(dir) {
  try { return fs.readdirSync(dir).map(name => path.join(dir, name)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

function markdownRoutine(text) {
  const routine = text.match(/^# Rutina:\s*([\w.-]+)/m)?.[1];
  if (!routine) return [];
  const repo = text.match(/\*\*Host:\*\*[^\n]*?\(([^)]+)\)/)?.[1];
  const cadence = text.match(/\*\*Cadencia:\*\*\s*(diaria|semanal)/i)?.[1]?.toLowerCase();
  return [{ routine, repo, cadence_hours: cadence === 'diaria' ? 24 : cadence === 'semanal' ? 168 : null }];
}

function readDeclarations(file, hidden = false) {
  if (!/\.(json|md)$/i.test(file)) return [];
  const stat = fs.statSync(file);
  if (!stat.isFile()) return [];
  const fileMs = Math.min(stat.mtimeMs, stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs);
  let data;
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    data = file.endsWith('.md') ? markdownRoutine(text) : JSON.parse(text);
  } catch {
    return [{ routine: path.basename(file, path.extname(file)), repo: 'unknown',
      registration_ms: fileMs, registration_file: path.basename(file), registration_error: 'unreadable routine registration' }];
  }
  const rows = Array.isArray(data) ? data : Array.isArray(data?.tasks) ? data.tasks : [data];
  return rows.filter(row => row && typeof row === 'object'
    && (hidden ? row.bot === true || row.kind === 'bot' || row.type === 'bot' : row.routine))
    .map(row => ({ ...row, routine: row.routine || row.id,
      registration_ms: row.registered_at ? Date.parse(row.registered_at)
        : fileMs,
      registration_file_ms: fileMs, registration_file: path.basename(file) }));
}

function loadRegistrations(intelDir) {
  const ordinary = filesIn(path.join(intelDir, 'routines')).flatMap(file => readDeclarations(file));
  const hidden = filesIn(path.join(intelDir, 'hidden-tasks')).flatMap(file => readDeclarations(file, true));
  const hiddenFile = path.join(intelDir, 'hidden-tasks.json');
  const rows = [...ordinary, ...hidden, ...(fs.existsSync(hiddenFile) ? readDeclarations(hiddenFile, true) : [])];
  // One finding per identity; JSON can supply precise registration metadata for a prose routine.
  const ordered = [...rows].sort((a, b) => Number(a.registration_file.endsWith('.json')) - Number(b.registration_file.endsWith('.json')));
  return [...new Map(ordered.map(row => [`${row.repo}::${row.routine}`, row])).values()];
}

function missingRunFinding(registration, runs, now) {
  if (registration.enabled === false) return null;
  const { routine, repo, registration_ms: registered } = registration;
  const cadence = Number(registration.cadence_hours);
  const valid = !registration.registration_error && routine && repo && Number.isFinite(registered) && Number.isFinite(cadence) && cadence > 0;
  const dueAt = registered + cadence * HOUR;
  if (valid && now < dueAt) return null;
  const windowStart = now - cadence * HOUR;
  const present = valid && runs.some(run => run.routine === routine && run.repo === repo
    && run.at_ms >= Math.max(registered, windowStart) && run.at_ms <= now);
  if (present) return null; // The existing run classifier still checks exit status and actual findings.
  return {
    id: `R-void-${routine || registration.registration_file}-${repo || 'unknown'}`,
    routine, repo: repo || 'unknown', state: 'routine', owner: null,
    title: `${routine || registration.registration_file} on ${repo || 'unknown'} has no valid run record`,
    category: 'routine-void', age_hours: Math.max(0, Math.floor((now - (valid ? dueAt
      : Number.isFinite(registered) ? registered : registration.registration_file_ms || now)) / HOUR)),
    why: valid
      ? `registered routine left no run-*.json in its ${cadence}h window; scheduler exit 0 is not execution evidence`
      : `invalid routine registration ${registration.registration_file}: ${registration.registration_error || 'require routine, repo, cadence_hours and valid registered_at'}`,
  };
}

function auditRegisteredRoutines(intelDir, runs, now) {
  return loadRegistrations(intelDir).map(row => missingRunFinding(row, runs, now)).filter(Boolean);
}

module.exports = { loadRegistrations, auditRegisteredRoutines };

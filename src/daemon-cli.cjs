'use strict';
// Daemon-only transport: synchronous CLI code runs in a disposable child,
// never in the HTTP/timer thread. No retries and no new polling loop.
const path = require('node:path');
const { fork, execFile } = require('node:child_process');
const DEADLINE_MS = 25000;
const MAX_DEADLINE_MS = 30000;
const MAX_ACTIVE = 4;
const WEZ_METHODS = ['listPanes', 'getFullText', 'getText', 'sendText',
  'sendTextNoEnter', 'sendTextBracketed', 'spawnPane', 'killPane', 'setTabTitle'];
const SEND_METHODS = ['sendPromptDeferredEnter', 'verifyPromptSubmission',
  'paneComposerHoldsForeignText', 'composerHoldsTail'];

function killProcessTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform !== 'win32') {
    try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch {} }
    return;
  }
  execFile('taskkill', ['/PID', String(pid), '/T', '/F'], {
    windowsHide: true, timeout: 2500, killSignal: 'SIGKILL',
  }, () => {});
}

function operationError(code, operation) {
  return Object.assign(new Error(`${operation}: ${code}; delivery may be unknown`), { code });
}

function finishJob(controller, job, error, value, terminate = false) {
  if (job.finished) return;
  job.finished = true;
  clearTimeout(job.timer);
  controller.active.delete(job);
  controller.last = { name: job.operation, started_at: new Date(job.started).toISOString(),
    age_ms: Date.now() - job.started, in_flight: false, error: error?.code || null };
  if (terminate) {
    try { controller.killTree(job.child?.pid); }
    catch (cleanupError) { controller.last = { ...controller.last, cleanup_error: cleanupError.message }; }
  }
  if (error) job.reject(error);
  else job.resolve(value);
}

function launchJob(controller, job, args) {
  try {
    const child = controller.forkFn(controller.workerPath, [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
      detached: process.platform !== 'win32',
    });
    job.child = child;
    child.unref?.();
    child.channel?.unref?.();
    child.once('error', error => finishJob(controller, job, error, null, true));
    child.once('exit', () => finishJob(controller, job, operationError('DAEMON_CLI_EXIT', job.operation)));
    child.once('message', message => {
      if (!message || message.type !== 'result') return;
      const error = message.error ? Object.assign(new Error(message.error.message), { code: message.error.code }) : null;
      // A successful spawn may deliberately leave a GUI alive. Every other
      // operation owns only disposable CLI descendants, even on native timeout.
      finishJob(controller, job, error, message.value, Boolean(error) || job.operation !== 'wez.spawnPane');
    });
    child.send({ operation: job.operation, args }, error => {
      if (error) finishJob(controller, job, error, null, true);
    });
  } catch (error) { finishJob(controller, job, error, null, true); }
}

function runOperation(controller, operation, args) {
  if (controller.active.size >= MAX_ACTIVE) return Promise.reject(operationError('DAEMON_CLI_BUSY', operation));
  return new Promise((resolve, reject) => {
    const job = { operation, started: Date.now(), resolve, reject, finished: false, child: null };
    controller.active.add(job);
    job.timer = setTimeout(() => finishJob(controller, job,
      operationError('DAEMON_CLI_TIMEOUT', operation), null, true), controller.timeoutMs);
    launchJob(controller, job, args);
  });
}

function transportStatus(controller) {
  const oldest = [...controller.active].sort((a, b) => a.started - b.started)[0];
  return { active: controller.active.size, deadline_ms: controller.timeoutMs,
    last_cli_call: oldest ? { name: oldest.operation, started_at: new Date(oldest.started).toISOString(),
      age_ms: Date.now() - oldest.started, in_flight: true } : controller.last };
}

function createDaemonCli({ timeoutMs = DEADLINE_MS, forkFn = fork, killTree = killProcessTree,
  workerPath = path.join(__dirname, 'daemon-cli-worker.cjs') } = {}) {
  const controller = { active: new Set(), last: null, forkFn, killTree, workerPath,
    timeoutMs: Math.min(MAX_DEADLINE_MS, Math.max(1, Number(timeoutMs) || DEADLINE_MS)) };
  const methods = (group, names) => Object.fromEntries(names.map(name =>
    [name, (...args) => runOperation(controller, `${group}.${name}`, args)]));
  return { wez: methods('wez', WEZ_METHODS), verified: methods('verified', SEND_METHODS),
    discoverPanes: () => runOperation(controller, 'discover', []),
    snapshot: options => runOperation(controller, 'snapshot', [options]),
    status: () => transportStatus(controller) };
}

module.exports = { ...createDaemonCli(), createDaemonCli, killProcessTree, DEADLINE_MS, MAX_DEADLINE_MS };

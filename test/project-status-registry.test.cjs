const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  latestByProject,
  readProjectStatuses,
  recordProjectStatus,
} = require('../src/project-status-registry.cjs');

function tempLog() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wezbridge-status-')), 'project-status.jsonl');
}

test('recordProjectStatus: writes JSONL and latestByProject returns newest per project', () => {
  const logPath = tempLog();
  assert.equal(recordProjectStatus({ project: 'memorymaster', status: 'active' }, { logPath, now: '2026-05-16T00:00:00Z' }), true);
  assert.equal(recordProjectStatus({ project: 'memorymaster', status: 'blocked' }, { logPath, now: '2026-05-16T00:01:00Z' }), true);

  const rows = readProjectStatuses({ logPath });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].recorded_at, '2026-05-16T00:00:00Z');

  const latest = latestByProject({ logPath });
  assert.equal(latest.memorymaster.status, 'blocked');
});

test('recordProjectStatus: rejects missing project', () => {
  assert.equal(recordProjectStatus({ status: 'active' }, { logPath: tempLog() }), false);
});

test('readProjectStatuses: returns [] for missing log and skips malformed lines', () => {
  const logPath = tempLog();
  fs.writeFileSync(logPath, '{"project":"a"}\nnot-json\n', 'utf8');
  assert.deepEqual(readProjectStatuses({ logPath }), [{ project: 'a' }]);
  assert.deepEqual(readProjectStatuses({ logPath: `${logPath}.missing` }), []);
});

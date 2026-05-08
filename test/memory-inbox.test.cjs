'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const inbox = require(path.resolve(__dirname, '..', 'src', 'memory-inbox.cjs'));

function tmpLog() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-inbox-'));
  return path.join(dir, 'inbox.jsonl');
}

function withEnv(key, value, fn) {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

test('record: no-op when WEZBRIDGE_MM_INBOX unset', () => {
  withEnv('WEZBRIDGE_MM_INBOX', undefined, () => {
    const logPath = tmpLog();
    const ok = inbox.record({ source: 'test', kind: 'block' }, { logPath });
    assert.equal(ok, false);
    assert.equal(fs.existsSync(logPath), false);
  });
});

test('record: no-op when WEZBRIDGE_MM_INBOX=0', () => {
  withEnv('WEZBRIDGE_MM_INBOX', '0', () => {
    const logPath = tmpLog();
    const ok = inbox.record({ source: 'test' }, { logPath });
    assert.equal(ok, false);
  });
});

test('record: writes when WEZBRIDGE_MM_INBOX=1', () => {
  withEnv('WEZBRIDGE_MM_INBOX', '1', () => {
    const logPath = tmpLog();
    const ok = inbox.record({ source: 'safety-policy', kind: 'block', reason: 'self-kill' }, { logPath });
    assert.equal(ok, true);
    const events = inbox.readEvents({ logPath });
    assert.equal(events.length, 1);
    assert.equal(events[0].source, 'safety-policy');
    assert.equal(events[0].kind, 'block');
    assert.equal(events[0].reason, 'self-kill');
  });
});

test('record: opts.force overrides env gate', () => {
  withEnv('WEZBRIDGE_MM_INBOX', undefined, () => {
    const logPath = tmpLog();
    const ok = inbox.record({ source: 'test' }, { logPath, force: true });
    assert.equal(ok, true);
  });
});

test('record: rejects events without `source`', () => {
  withEnv('WEZBRIDGE_MM_INBOX', '1', () => {
    const logPath = tmpLog();
    assert.equal(inbox.record(null, { logPath }), false);
    assert.equal(inbox.record({}, { logPath }), false);
    assert.equal(inbox.record({ kind: 'orphan' }, { logPath }), false);
  });
});

test('readEvents: returns [] when file absent', () => {
  assert.deepEqual(inbox.readEvents({ logPath: '/no/such/inbox.jsonl' }), []);
});

test('readEvents: skips malformed lines', () => {
  withEnv('WEZBRIDGE_MM_INBOX', '1', () => {
    const logPath = tmpLog();
    inbox.record({ source: 'a' }, { logPath });
    fs.appendFileSync(logPath, 'garbage\n', 'utf8');
    inbox.record({ source: 'b' }, { logPath });
    assert.equal(inbox.readEvents({ logPath }).length, 2);
  });
});

test('isEnabled returns true only for "1"', () => {
  withEnv('WEZBRIDGE_MM_INBOX', '1', () => assert.equal(inbox.isEnabled(), true));
  withEnv('WEZBRIDGE_MM_INBOX', '0', () => assert.equal(inbox.isEnabled(), false));
  withEnv('WEZBRIDGE_MM_INBOX', 'true', () => assert.equal(inbox.isEnabled(), false));
  withEnv('WEZBRIDGE_MM_INBOX', undefined, () => assert.equal(inbox.isEnabled(), false));
});

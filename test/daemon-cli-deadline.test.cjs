'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createDaemonCli } = require('../src/daemon-cli.cjs');

// An IPC child which accepts work but never executes or sends a result: there
// is no native exec timeout in this fixture. Only the real parent's timer acts.
function hungChildren() {
  const children = [];
  const killed = [];
  const forkFn = () => {
    const child = new EventEmitter();
    child.pid = 47000 + children.length;
    child.send = (message, callback) => { child.request = message; callback(null); };
    children.push(child);
    return child;
  };
  return { children, killed, forkFn, killTree: pid => killed.push(pid) };
}

test('T-0474 daemon deadline alone rejects and calls killTree with the hung child pid', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fixture = hungChildren();
  const cli = createDaemonCli({ timeoutMs: 100, ...fixture });
  const outcomes = [];
  cli.wez.getFullText(8701).then(value => outcomes.push({ value }), error => outcomes.push({ error }));
  assert.equal(fixture.children.length, 1);
  assert.equal(fixture.children[0].request.operation, 'wez.getFullText');
  t.mock.timers.tick(99);
  await Promise.resolve();
  assert.equal(outcomes.length, 0, 'the child must still be hung before the daemon deadline');
  assert.deepEqual(fixture.killed, []);
  t.mock.timers.tick(1);
  await Promise.resolve();
  assert.equal(outcomes.length, 1, 'the daemon deadline must settle the hung operation');
  assert.equal(outcomes[0].error?.code, 'DAEMON_CLI_TIMEOUT');
  assert.deepEqual(fixture.killed, [fixture.children[0].pid], 'killTree must receive the owned hung worker pid');
  assert.equal(cli.status().active, 0);
  // Late IPC/exit cannot settle or kill the same job a second time.
  fixture.children[0].emit('message', { type: 'result', value: 'late' });
  fixture.children[0].emit('exit', 0);
  await Promise.resolve();
  assert.equal(outcomes.length, 1);
  assert.deepEqual(fixture.killed, [fixture.children[0].pid]);
});

test('T-0474 four hung jobs reject a fifth as BUSY until the daemon deadline frees the slots', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fixture = hungChildren();
  const cli = createDaemonCli({ timeoutMs: 100, ...fixture });
  const outcomes = [];
  for (const pane of [8701, 8702, 8703, 8704]) {
    cli.wez.getFullText(pane).then(value => outcomes.push({ value }), error => outcomes.push({ error }));
  }
  assert.equal(cli.status().active, 4);
  t.mock.timers.tick(99);
  await assert.rejects(cli.wez.getFullText(8705), { code: 'DAEMON_CLI_BUSY' });
  assert.equal(fixture.children.length, 4, 'the rejected fifth request must not fork');
  assert.equal(outcomes.length, 0);
  t.mock.timers.tick(1);
  await Promise.resolve();
  assert.equal(outcomes.length, 4, 'all four daemon deadlines must settle');
  assert.deepEqual(outcomes.map(x => x.error?.code), Array(4).fill('DAEMON_CLI_TIMEOUT'));
  assert.deepEqual(fixture.killed, fixture.children.map(child => child.pid));
  assert.equal(cli.status().active, 0, 'timed-out jobs must relinquish their slots');
  const next = cli.wez.getFullText(9000);
  // Attach a rejection handler before assertions, so a broken slot-release
  // path reports its assertion rather than an unrelated unhandled rejection.
  next.catch(() => {});
  assert.equal(fixture.children.length, 5, 'a request after the deadline must be admitted, not BUSY');
  fixture.children[4].emit('message', { type: 'result', value: 'new operation' });
  assert.equal(await next, 'new operation');
  assert.equal(cli.status().active, 0);
});

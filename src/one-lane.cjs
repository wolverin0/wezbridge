'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function validateOrder(order) {
  if (!order || !/^[a-zA-Z0-9._-]{1,64}$/.test(order.id || '') ||
      !/^[a-zA-Z0-9._:-]{1,64}$/.test(order.corr || '') ||
      !Number.isInteger(order.pane) || order.pane < 0 ||
      !Number.isInteger(order.from_pane) || order.from_pane < 0 ||
      typeof order.project !== 'string' || !/^(?:[a-z]:[\\/]|\/)/i.test(order.project) ||
      typeof order.body !== 'string' || !order.body.trim() || order.body.length > 600 ||
      order.scope !== 'read_only') throw new Error('invalid-order: explicit read_only project+pane required');
  return { id: order.id, corr: order.corr, project: order.project, pane: order.pane,
    from_pane: order.from_pane, scope: order.scope, body: order.body };
}

function writeOnce(file, value) {
  const fd = fs.openSync(file, 'wx');
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}

function decodeTransport(response) {
  if (response.error) return { state: 'dispatch_uncertain', response };
  const result = response.result || response;
  let parsed;
  try { parsed = JSON.parse(result.content?.[0]?.text); } catch { parsed = {}; }
  const state = !result.isError && parsed.submitted === 'submitted' && parsed.delivered === 'ok'
    ? 'submitted' : 'dispatch_uncertain';
  return { state, response };
}

async function dispatch({ root, input, call }) {
  const order = validateOrder(input);
  fs.mkdirSync(root, { recursive: true });
  const dir = path.join(root, order.id);
  // Exclusive claim is intentionally never stolen: after a crash, an operator
  // must inspect the pane/result before authorizing a new attempt id.
  fs.mkdirSync(dir);
  writeOnce(path.join(dir, 'receipt.json'), { version: 1, state: 'received',
    received_at: new Date().toISOString(), order, sha256: digest(order) });
  const body = `READ-ONLY order ${order.id}. No edits, payments, outreach, deploy, customer actions or scope expansion. Return type=result with criteria/files_changed/next_action to pane-${order.from_pane}, same corr.\n${order.body}`;
  writeOnce(path.join(dir, 'dispatch-started.json'), { at: new Date().toISOString() });
  let outcome;
  try {
    outcome = decodeTransport(await call('a2a_send', { to_pane: order.pane,
      expected_cwd: order.project, from_pane: order.from_pane, type: 'request', corr: order.corr, body }));
  } catch (error) { outcome = { state: 'dispatch_uncertain', error: error.message }; }
  writeOnce(path.join(dir, 'dispatch.json'), { at: new Date().toISOString(), ...outcome });
  return { dir, state: outcome.state };
}

function matchesResult(receipt, row) {
  const { order } = receipt;
  const escaped = order.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return row.corr === order.corr && row.from_pane === order.pane &&
    row.to_pane === order.from_pane && Date.parse(row.time) >= Date.parse(receipt.received_at) &&
    typeof row.body === 'string' && new RegExp(`^order:\\s*${escaped}(?:\\s|$)`, 'mi').test(row.body) &&
    /^criteria:\s*$/mi.test(row.body) && /^\s*- .+: (pass|fail)\b/mi.test(row.body);
}

function collect({ dir, ledger }) {
  const receipt = JSON.parse(fs.readFileSync(path.join(dir, 'receipt.json'), 'utf8'));
  if (receipt.sha256 !== digest(receipt.order)) throw new Error('receipt-integrity-failed');
  const rows = fs.readFileSync(ledger, 'utf8').split(/\r?\n/).filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  const result = rows.find(row => matchesResult(receipt, row));
  if (!result) throw new Error('no-matching-result');
  const artifact = { state: 'result_received_not_accepted', collected_at: new Date().toISOString(),
    result, sha256: digest(result) };
  writeOnce(path.join(dir, 'result.json'), artifact);
  return artifact;
}

module.exports = { validateOrder, writeOnce, decodeTransport, dispatch, collect, digest, matchesResult };

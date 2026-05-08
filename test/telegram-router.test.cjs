'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const router = require(path.resolve(__dirname, '..', 'src', 'telegram-router.cjs'));
const { loadTopicMap, routeInbound, DEFAULT_PATH } = router;

function tmpJson(obj) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-router-'));
  const file = path.join(dir, 'topics.json');
  fs.writeFileSync(file, JSON.stringify(obj), 'utf8');
  return file;
}

// loadTopicMap ---------------------------------------------------------

test('loadTopicMap: returns empty maps when file is missing', () => {
  const map = loadTopicMap({ path: '/no/such/file.json' });
  assert.equal(map.byTopic.size, 0);
  assert.equal(map.byProject.size, 0);
  assert.equal(map.groupId, null);
});

test('loadTopicMap: builds bidirectional maps + groupId', () => {
  const file = tmpJson({
    omniclaude: 2,
    memorymaster: 3,
    wezbridge: 214,
    _group_id: '-1003782914786',
  });
  const map = loadTopicMap({ path: file });
  assert.equal(map.byTopic.get(2), 'omniclaude');
  assert.equal(map.byTopic.get(3), 'memorymaster');
  assert.equal(map.byTopic.get(214), 'wezbridge');
  assert.equal(map.byProject.get('memorymaster'), 3);
  assert.equal(map.byProject.get('wezbridge'), 214);
  assert.equal(map.groupId, '-1003782914786');
});

test('loadTopicMap: skips non-integer values without throwing', () => {
  const file = tmpJson({
    valid: 5,
    notes: 'this is a string',
    weird: 5.5,
    _group_id: '-100',
  });
  const map = loadTopicMap({ path: file });
  assert.equal(map.byTopic.size, 1);
  assert.equal(map.byTopic.get(5), 'valid');
});

test('loadTopicMap: malformed JSON returns empty', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-router-'));
  const file = path.join(dir, 'broken.json');
  fs.writeFileSync(file, '{ invalid json', 'utf8');
  const map = loadTopicMap({ path: file });
  assert.equal(map.byTopic.size, 0);
});

// routeInbound ---------------------------------------------------------

const fixture = {
  byTopic: new Map([[3, 'memorymaster'], [214, 'wezbridge']]),
  byProject: new Map([['memorymaster', 3], ['wezbridge', 214]]),
  groupId: '-1003782914786',
  path: '<test>',
};

test('routeInbound: group + known topic → route', () => {
  const r = routeInbound(
    { chat_id: '-1003782914786', message_thread_id: '3' },
    { topicMap: fixture },
  );
  assert.equal(r.action, 'route');
  assert.equal(r.project, 'memorymaster');
  assert.equal(r.threadId, 3);
});

test('routeInbound: group + unknown topic → unknown_topic', () => {
  const r = routeInbound(
    { chat_id: '-1003782914786', message_thread_id: 999 },
    { topicMap: fixture },
  );
  assert.equal(r.action, 'unknown_topic');
  assert.equal(r.project, null);
  assert.equal(r.threadId, 999);
});

test('routeInbound: group + no thread → self (general chat)', () => {
  const r = routeInbound(
    { chat_id: '-1003782914786', message_thread_id: null },
    { topicMap: fixture },
  );
  assert.equal(r.action, 'self');
  assert.equal(r.threadId, null);
});

test('routeInbound: private DM → self', () => {
  const r = routeInbound(
    { chat_id: '2128295779', message_thread_id: null },
    { topicMap: fixture },
  );
  assert.equal(r.action, 'self');
});

test('routeInbound: different group → unknown_chat', () => {
  const r = routeInbound(
    { chat_id: '-987654321', message_thread_id: 3 },
    { topicMap: fixture },
  );
  assert.equal(r.action, 'unknown_chat');
});

test('routeInbound: accepts both string and number thread_id', () => {
  const a = routeInbound(
    { chat_id: '-1003782914786', message_thread_id: '3' },
    { topicMap: fixture },
  );
  const b = routeInbound(
    { chat_id: '-1003782914786', message_thread_id: 3 },
    { topicMap: fixture },
  );
  assert.equal(a.action, 'route');
  assert.equal(b.action, 'route');
  assert.equal(a.project, b.project);
});

test('routeInbound: empty string thread_id treated as no thread', () => {
  const r = routeInbound(
    { chat_id: '-1003782914786', message_thread_id: '' },
    { topicMap: fixture },
  );
  assert.equal(r.action, 'self');
});

// constants ------------------------------------------------------------

test('DEFAULT_PATH points at ~/.omniclaude/telegram-topics.json', () => {
  assert.match(DEFAULT_PATH, /\.omniclaude/);
  assert.match(DEFAULT_PATH, /telegram-topics\.json$/);
});

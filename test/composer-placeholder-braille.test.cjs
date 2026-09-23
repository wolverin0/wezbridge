'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { composerHoldsForeignText, inputBoxContent } = require('../src/verified-send.cjs');

test('T-0451 measured Codex placeholder with braille animation is empty', () => {
  const line = '\u203a Ask Codex to do anything\u2840  \u2808     \u2808 \u2802   \u2801';
  assert.equal(composerHoldsForeignText(line), false);
  assert.equal(inputBoxContent([line]), 'ask codex to do anything');
});

test('T-0451 animation across the braille range does not hide the placeholder', () => {
  for (let point = 0x2800; point <= 0x28ff; point++) {
    assert.equal(composerHoldsForeignText(`\u203a Ask Codex to do anything${String.fromCharCode(point)}`), false);
  }
});

test('T-0451 real text and braille-only user input remain protected', () => {
  for (const value of ['hola \u2802\u2801', '\u2803\u2817', 'Ask Codex to do anything hola \u2801']) {
    assert.equal(composerHoldsForeignText(`\u203a ${value}`), true);
    assert.equal(inputBoxContent([`\u203a ${value}`]), value.toLowerCase());
  }
});

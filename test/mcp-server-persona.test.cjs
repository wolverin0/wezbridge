'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

function callSpawnSessionWithPersona(persona) {
  return new Promise((resolve, reject) => {
    const entry = path.join(__dirname, '..', 'src', 'mcp-server.cjs');
    const child = spawn(process.execPath, [entry], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`mcp-server timed out; stderr=${stderr}`));
    }, 5000);

    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const newline = stdout.indexOf('\n');
      if (newline === -1) return;
      clearTimeout(timer);
      const line = stdout.slice(0, newline).trim();
      child.stdin.end();
      child.kill('SIGTERM');
      try {
        resolve(JSON.parse(line));
      } catch (err) {
        reject(new Error(`invalid JSON response: ${err.message}; stdout=${stdout}; stderr=${stderr}`));
      }
    });
    child.on('error', reject);

    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'spawn_session',
        arguments: {
          cwd: path.join(__dirname, '..'),
          persona,
        },
      },
    }) + '\n');
  });
}

for (const persona of ['../etc/passwd', '/etc/passwd', '..\\windows\\system32', 'foo/bar']) {
  test(`spawn_session rejects path-traversal persona ${persona}`, async () => {
    const response = await callSpawnSessionWithPersona(persona);
    assert.equal(response.jsonrpc, '2.0');
    assert.equal(response.id, 1);
    assert.equal(response.result.isError, true);
    assert.match(response.result.content[0].text, /invalid persona name/i);
  });
}

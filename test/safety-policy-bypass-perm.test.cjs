'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { assertBypassPermissionsAllowed } = require(path.resolve(__dirname, '..', 'src', 'safety-policy.cjs'));

function withEnv(key, value, fn) {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

test('assertBypassPermissionsAllowed throws for bypassPermissions without env gate', () => {
  withEnv('WEZBRIDGE_ALLOW_SKIP_PERMISSIONS', undefined, () => {
    assert.throws(
      () => assertBypassPermissionsAllowed({ body: { permission_mode: 'bypassPermissions' } }),
      /WEZBRIDGE_ALLOW_SKIP_PERMISSIONS=true/
    );
  });
});

test('assertBypassPermissionsAllowed allows bypassPermissions with env gate', () => {
  withEnv('WEZBRIDGE_ALLOW_SKIP_PERMISSIONS', 'true', () => {
    assert.equal(
      assertBypassPermissionsAllowed({ body: { permission_mode: 'bypassPermissions' } }),
      null
    );
  });
});

test('assertBypassPermissionsAllowed allows unset and non-bypass permission modes', () => {
  withEnv('WEZBRIDGE_ALLOW_SKIP_PERMISSIONS', undefined, () => {
    assert.equal(assertBypassPermissionsAllowed({ body: {} }), null);
    assert.equal(assertBypassPermissionsAllowed({ body: { permission_mode: 'default' } }), null);
    assert.equal(assertBypassPermissionsAllowed({ body: { permission_mode: 'acceptEdits' } }), null);
  });
});

test('spawn_session rejects unknown permission_mode values', async () => {
  const result = await callMcpTool('spawn_session', { permission_mode: 'root' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /invalid permission_mode "root"/);
});

function callMcpTool(name, args) {
  const { spawn } = require('node:child_process');
  const serverPath = path.resolve(__dirname, '..', 'src', 'mcp-server.cjs');
  const child = spawn(process.execPath, [serverPath], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });

  child.stdin.write(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  }) + '\n');
  child.stdin.end();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`MCP call timed out. stdout=${stdout} stderr=${stderr}`));
    }, 5000);

    child.on('error', reject);
    child.on('exit', () => {
      clearTimeout(timer);
      const line = stdout.split('\n').find(Boolean);
      if (!line) {
        reject(new Error(`MCP call produced no stdout. stderr=${stderr}`));
        return;
      }
      const message = JSON.parse(line);
      if (message.error) {
        reject(new Error(`MCP JSON-RPC error: ${JSON.stringify(message.error)}`));
        return;
      }
      resolve(message.result);
    });
  });
}

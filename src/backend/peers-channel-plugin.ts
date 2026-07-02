/**
 * wezbridge-peers channel plugin generator.
 *
 * Writes a self-contained Claude Code channel plugin to
 * `~/.claude/plugins/cache/wezbridge-local/wezbridge-peers/<VERSION>/` so
 * Claude Code can load it via `--channels plugin:wezbridge-peers@wezbridge-local`.
 *
 * The plugin is a pure-Node MCP stdio server (no Bun, no extra deps beyond
 * @modelcontextprotocol/sdk) that:
 *   1. Reads its own pane_id from THEORCHESTRA_PANE_ID env (injected by
 *      PtyManager.spawn() — every spawned process inherits this).
 *   2. POSTs to /broker/register on startup + every poll cycle to refresh
 *      its last_seen_at.
 *   3. Polls /broker/poll/:pane_id every 1s; for each new message, pushes
 *      via `server.notification({method: 'notifications/claude/channel',
 *      params: {content, meta}})` — that's the canonical Claude Code
 *      channel-push primitive (confirmed via louislva/claude-peers-mcp).
 *
 * Idempotent: ensurePlugin() bails fast if the plugin dir already has the
 * current version. The npm install step runs once per version bump.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const PLUGIN_VERSION = '0.1.0';
const PLUGIN_NAME = 'wezbridge-peers';
const SOURCE_NAME = 'wezbridge-local';
export const PLUGIN_SLUG = `${PLUGIN_NAME}@${SOURCE_NAME}`;

interface EnsureOpts {
  brokerUrl?: string;
  /** Path to bearer token file the plugin should read for /broker/* auth. */
  tokenFile?: string;
}

interface EnsureResult {
  installed: boolean;
  pluginRoot: string;
  /** The slug to pass to claude --channels plugin:<slug>. */
  slug: string;
  /** Env vars to inject into the spawned Claude process. */
  envExtras: Record<string, string>;
}

function pluginRoot(): string {
  return path.join(
    os.homedir(),
    '.claude',
    'plugins',
    'cache',
    SOURCE_NAME,
    PLUGIN_NAME,
    PLUGIN_VERSION,
  );
}

function writeFileIfMissing(filePath: string, content: string): boolean {
  if (fs.existsSync(filePath)) {
    // Always overwrite if content differs — lets us push fixes without bumping version.
    try {
      const existing = fs.readFileSync(filePath, 'utf-8');
      if (existing === content) return false;
    } catch {
      /* fall through to write */
    }
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
  return true;
}

const PLUGIN_JSON = JSON.stringify(
  {
    name: PLUGIN_NAME,
    description:
      'wezbridge peers channel — Claude<->Claude push messaging via the theorchestra peers broker. Polls the broker every 1s and pushes inbound messages into the Claude session via the channel protocol.',
    version: PLUGIN_VERSION,
    keywords: ['theorchestra', 'wezbridge', 'peers', 'a2a', 'channel'],
  },
  null,
  2,
);

const MCP_JSON = JSON.stringify(
  {
    mcpServers: {
      'wezbridge-peers': {
        command: 'node',
        args: ['${CLAUDE_PLUGIN_ROOT}/server.cjs'],
      },
    },
  },
  null,
  2,
);

const PACKAGE_JSON = JSON.stringify(
  {
    name: 'wezbridge-peers-channel',
    version: PLUGIN_VERSION,
    private: true,
    main: 'server.cjs',
    dependencies: {
      '@modelcontextprotocol/sdk': '^1.27.1',
    },
  },
  null,
  2,
);

const SERVER_CJS = String.raw`#!/usr/bin/env node
/**
 * wezbridge-peers channel server.
 *
 * Polls the theorchestra peers broker every 1s and pushes inbound messages
 * into the Claude Code session via the channel notification protocol.
 *
 * Identity: reads THEORCHESTRA_PANE_ID from env (injected by PtyManager.spawn).
 * Broker URL: THEORCHESTRA_BACKEND_URL env or defaults to http://127.0.0.1:4300.
 * Auth: THEORCHESTRA_TOKEN env, or reads from THEORCHESTRA_TOKEN_FILE, or
 *       defaults to the project-relative vault/_auth/token.json.
 *
 * stdout is the MCP protocol stream — every log MUST go to stderr.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

const PANE_ID = process.env.THEORCHESTRA_PANE_ID || null;
const BROKER_URL = (process.env.THEORCHESTRA_BACKEND_URL || 'http://127.0.0.1:4300').replace(/\/$/, '');
const POLL_INTERVAL_MS = Number(process.env.THEORCHESTRA_PEERS_POLL_MS || 1000);

function log(msg) {
  process.stderr.write('[wezbridge-peers] ' + String(msg) + '\n');
}

function readTokenFile() {
  const explicit = process.env.THEORCHESTRA_TOKEN_FILE;
  const candidates = [
    explicit,
    path.join(process.cwd(), 'vault', '_auth', 'token.json'),
    path.join(process.env.HOME || process.env.USERPROFILE || '', '.theorchestra', 'token.json'),
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) {
        const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
        if (raw && typeof raw.token === 'string' && raw.token.length > 0) return raw.token;
      }
    } catch {
      /* continue */
    }
  }
  return null;
}

const TOKEN = process.env.THEORCHESTRA_TOKEN || readTokenFile();

async function brokerFetch(method, pathname, body) {
  const url = BROKER_URL + pathname;
  const headers = { 'Content-Type': 'application/json' };
  if (TOKEN) headers['Authorization'] = 'Bearer ' + TOKEN;
  const init = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  try {
    const res = await fetch(url, init);
    const text = await res.text();
    if (!res.ok) {
      log('broker ' + res.status + ' on ' + method + ' ' + pathname + ': ' + text.slice(0, 120));
      return null;
    }
    if (text.length === 0) return {};
    try { return JSON.parse(text); } catch { return text; }
  } catch (err) {
    log('fetch err on ' + method + ' ' + pathname + ': ' + (err && err.message ? err.message : err));
    return null;
  }
}

async function main() {
  if (!PANE_ID) {
    log('THEORCHESTRA_PANE_ID not set — cannot register with broker. Plugin will idle.');
  }
  const server = new Server(
    { name: 'wezbridge-peers', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  // No tools exposed — this plugin is pure inbound channel push.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
  server.setRequestHandler(CallToolRequestSchema, async () => ({
    content: [{ type: 'text', text: 'wezbridge-peers exposes no tools (channel-only).' }],
    isError: true,
  }));

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('connected stdio transport (pane_id=' + (PANE_ID || 'none') + ', broker=' + BROKER_URL + ')');

  // Initial register
  if (PANE_ID) {
    await brokerFetch('POST', '/broker/register', { pane_id: PANE_ID });
  }

  // Poll loop — re-register every poll so last_seen_at stays fresh.
  setInterval(async () => {
    if (!PANE_ID) return;
    const result = await brokerFetch('GET', '/broker/poll/' + encodeURIComponent(PANE_ID));
    if (!result || !Array.isArray(result.messages) || result.messages.length === 0) return;
    for (const msg of result.messages) {
      try {
        await server.notification({
          method: 'notifications/claude/channel',
          params: {
            content: msg.body,
            meta: {
              from_id: msg.from_pane_id,
              corr_id: msg.corr_id,
              sent_at: msg.sent_at,
              message_id: msg.id,
            },
          },
        });
        log('pushed msg ' + msg.id + ' from ' + (msg.from_pane_id || '?').slice(0, 8));
      } catch (err) {
        log('push err: ' + (err && err.message ? err.message : err));
      }
    }
  }, POLL_INTERVAL_MS);

  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
}

main().catch((err) => {
  log('fatal: ' + (err && (err.stack || err.message) || err));
  process.exit(1);
});
`;

let installRanThisProcess = false;

function ensureNpmInstall(rootDir: string): void {
  // Skip if node_modules/@modelcontextprotocol/sdk already exists.
  const sdkMarker = path.join(rootDir, 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json');
  if (fs.existsSync(sdkMarker)) return;
  if (installRanThisProcess) return; // avoid duplicate install in same backend boot
  installRanThisProcess = true;
  console.log('[wezbridge-peers] installing plugin deps in ' + rootDir + ' (one-time)');
  const result = spawnSync('npm', ['install', '--no-audit', '--no-fund', '--silent'], {
    cwd: rootDir,
    stdio: 'inherit',
    shell: true,
  });
  if (result.status !== 0) {
    console.warn('[wezbridge-peers] npm install exited with status ' + result.status);
  } else {
    console.log('[wezbridge-peers] plugin deps installed');
  }
}

// Currently unused — see note in ensurePlugin() about why local-source
// registration breaks Claude Code's marketplace validator. Kept for future
// use if/when Claude Code grows official local-plugin support.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _registerInPluginRegistries(rootDir: string): void {
  const homeDir = os.homedir();
  // installed_plugins.json — register so Claude Code knows about it.
  const installedPath = path.join(homeDir, '.claude', 'plugins', 'installed_plugins.json');
  try {
    let installed: any = { version: 2, plugins: {} };
    if (fs.existsSync(installedPath)) {
      installed = JSON.parse(fs.readFileSync(installedPath, 'utf-8'));
      if (!installed.plugins) installed.plugins = {};
    }
    const key = PLUGIN_SLUG;
    const entry = {
      scope: 'user',
      installPath: rootDir,
      version: PLUGIN_VERSION,
      installedAt: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
      gitCommitSha: 'local',
    };
    const existing = Array.isArray(installed.plugins[key]) ? installed.plugins[key] : [];
    const filtered = existing.filter((e: any) => e.version !== PLUGIN_VERSION);
    installed.plugins[key] = [...filtered, entry];
    fs.writeFileSync(installedPath, JSON.stringify(installed, null, 2), 'utf-8');
  } catch (err) {
    console.warn(
      '[wezbridge-peers] could not update installed_plugins.json: ' +
        (err instanceof Error ? err.message : String(err)),
    );
  }

  // known_marketplaces.json — needs an entry for our source so Claude Code accepts the @source.
  const marketplacesPath = path.join(homeDir, '.claude', 'plugins', 'known_marketplaces.json');
  try {
    let mkts: any = {};
    if (fs.existsSync(marketplacesPath)) {
      mkts = JSON.parse(fs.readFileSync(marketplacesPath, 'utf-8'));
    }
    if (!mkts[SOURCE_NAME]) {
      mkts[SOURCE_NAME] = {
        source: { source: 'local', path: path.join(homeDir, '.claude', 'plugins', 'cache', SOURCE_NAME) },
        installLocation: path.join(homeDir, '.claude', 'plugins', 'marketplaces', SOURCE_NAME),
        lastUpdated: new Date().toISOString(),
      };
      fs.writeFileSync(marketplacesPath, JSON.stringify(mkts, null, 2), 'utf-8');
    }
  } catch (err) {
    console.warn(
      '[wezbridge-peers] could not update known_marketplaces.json: ' +
        (err instanceof Error ? err.message : String(err)),
    );
  }
}

/**
 * Idempotent generator. Writes the plugin tree if missing, runs npm install
 * (one-time per version), and registers the plugin so Claude Code accepts
 * `--channels plugin:wezbridge-peers@wezbridge-local`.
 */
export function ensurePlugin(opts: EnsureOpts = {}): EnsureResult {
  const root = pluginRoot();
  const wrote: string[] = [];
  if (writeFileIfMissing(path.join(root, '.claude-plugin', 'plugin.json'), PLUGIN_JSON)) wrote.push('plugin.json');
  if (writeFileIfMissing(path.join(root, '.mcp.json'), MCP_JSON)) wrote.push('.mcp.json');
  if (writeFileIfMissing(path.join(root, 'package.json'), PACKAGE_JSON)) wrote.push('package.json');
  if (writeFileIfMissing(path.join(root, 'server.cjs'), SERVER_CJS)) wrote.push('server.cjs');
  ensureNpmInstall(root);
  // NOTE: registerInPluginRegistries() is intentionally NOT called from the
  // default ensurePlugin path. Adding our plugin to known_marketplaces.json
  // with source:'local' was rejected by Claude Code's marketplace validator
  // and broke ALL plugin loading (Telegram + theorchestra MCP went into the
  // disconnected list on every spawn). Until we have a sanctioned way to
  // register a local channel plugin, the wezbridge-peers MCP server is
  // mounted on demand via the project-local .mcp.json that omniclaude-driver
  // writes — see writeMcpJson() — so it loads as a regular MCP server.
  // _registerInPluginRegistries(root); // disabled — see above

  const envExtras: Record<string, string> = {};
  if (opts.brokerUrl) envExtras.THEORCHESTRA_BACKEND_URL = opts.brokerUrl;
  if (opts.tokenFile) envExtras.THEORCHESTRA_TOKEN_FILE = opts.tokenFile;

  if (wrote.length > 0) {
    console.log(
      `[wezbridge-peers] ensurePlugin updated ${wrote.length} file(s): ${wrote.join(', ')} at ${root}`,
    );
  }
  return {
    installed: true,
    pluginRoot: root,
    slug: PLUGIN_SLUG,
    envExtras,
  };
}

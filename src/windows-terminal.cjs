/**
 * Windows Terminal Backend — alternative to wezterm.cjs for Windows Terminal.
 *
 * Windows Terminal does NOT have a CLI like WezTerm's `wezterm cli send-text`.
 * This module provides terminal control via two strategies:
 *
 * 1. **PowerShell + SendKeys** — uses COM automation to send keystrokes
 *    (requires Windows Terminal to be the focused window)
 *
 * 2. **Headless via Claude Agent SDK** — runs Claude Code sessions programmatically
 *    without any terminal GUI. This is the RECOMMENDED approach for orchestration
 *    because it gives full programmatic control without needing GUI interaction.
 *
 * The headless approach is actually superior for orchestration because:
 * - No GUI dependency — works on servers, CI, headless machines
 * - Programmatic output capture — no need to scrape terminal text
 * - Direct prompt injection — no need for send-text hacks
 * - Session resume/fork — full SDK session management
 *
 * Set env var WEZBRIDGE_BACKEND=wt to use Windows Terminal
 * Set env var WEZBRIDGE_BACKEND=headless to use Claude Agent SDK (recommended)
 */
const { execSync, spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');

const events = new EventEmitter();

// ─── Strategy 1: Windows Terminal via PowerShell ────────────────────────────

/**
 * Check if Windows Terminal is available.
 */
function isWindowsTerminalAvailable() {
  try {
    execSync('where wt.exe', { encoding: 'utf-8', timeout: 3000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Spawn a new Windows Terminal tab/pane.
 * Returns a process handle (not a pane ID like WezTerm).
 */
function spawnWtPane({ cwd, profile } = {}) {
  const args = [];
  if (profile) args.push('-p', profile);
  if (cwd) args.push('-d', cwd);

  try {
    const child = spawn('wt.exe', ['nt', ...args], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.unref();
    return { pid: child.pid, type: 'wt' };
  } catch (err) {
    throw new Error(`Windows Terminal spawn failed: ${err.message}`);
  }
}

/**
 * Split the current Windows Terminal pane.
 */
function splitWtPane({ direction = 'horizontal', cwd, profile } = {}) {
  const args = ['sp'];
  if (direction === 'horizontal') args.push('-H');
  else args.push('-V');
  if (profile) args.push('-p', profile);
  if (cwd) args.push('-d', cwd);

  try {
    execSync(`wt.exe ${args.join(' ')}`, { encoding: 'utf-8', timeout: 5000, windowsHide: true });
  } catch (err) {
    throw new Error(`Windows Terminal split failed: ${err.message}`);
  }
}

// ─── Strategy 2: Headless Claude Agent SDK ─────────────────────────────────
// This is the recommended approach for the orchestrator.
// Instead of controlling a GUI terminal, we run Claude Code sessions
// programmatically via the Agent SDK.

/**
 * HeadlessSession — wraps Claude Agent SDK to provide a session interface
 * compatible with WezBridge's session-manager expectations.
 *
 * Usage:
 *   const session = new HeadlessSession({ cwd: '/path/to/project' });
 *   const result = await session.sendPrompt('Fix the tests');
 *   // result streams back as events
 */
class HeadlessSession {
  constructor({ cwd, sessionId, allowedTools, permissionMode } = {}) {
    this.cwd = cwd || process.cwd();
    this.sessionId = sessionId || null; // For resume
    this.allowedTools = allowedTools || ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep'];
    this.permissionMode = permissionMode || 'default';
    this.events = new EventEmitter();
    this.lastOutput = '';
    this.status = 'idle'; // idle | running | completed | error
    this._process = null;
  }

  /**
   * Send a prompt to the headless Claude Code session.
   * Uses `claude` CLI in non-interactive (pipe) mode.
   * @param {string} prompt
   * @returns {Promise<string>} The response text
   */
  async sendPrompt(prompt) {
    this.status = 'running';
    this.events.emit('status', 'running');

    return new Promise((resolve, reject) => {
      const args = ['--print'];
      if (this.sessionId) args.push('--resume', this.sessionId);

      // Use claude CLI in print mode for headless operation
      const child = spawn('claude', [...args, prompt], {
        cwd: this.cwd,
        env: { ...process.env, NO_COLOR: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this._process = child;
      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (chunk) => {
        const text = chunk.toString();
        stdout += text;
        this.lastOutput = stdout;
        this.events.emit('output', text);
      });

      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      child.on('close', (code) => {
        this._process = null;
        if (code === 0) {
          this.status = 'completed';
          this.lastOutput = stdout;
          this.events.emit('status', 'completed');
          this.events.emit('completed', stdout);
          resolve(stdout);
        } else {
          this.status = 'error';
          this.events.emit('status', 'error');
          this.events.emit('error', stderr || `Exit code ${code}`);
          reject(new Error(stderr || `claude exited with code ${code}`));
        }
      });

      child.on('error', (err) => {
        this._process = null;
        this.status = 'error';
        this.events.emit('error', err.message);
        reject(err);
      });
    });
  }

  /**
   * Send a prompt using the Claude Agent SDK (TypeScript/Python).
   * This gives full streaming, tool execution visibility, and session management.
   * Requires @anthropic-ai/claude-agent-sdk to be installed.
   */
  async sendPromptSDK(prompt) {
    // Check if SDK is available
    let sdk;
    try {
      sdk = require('@anthropic-ai/claude-agent-sdk');
    } catch {
      // Fall back to CLI mode
      return this.sendPrompt(prompt);
    }

    this.status = 'running';
    this.events.emit('status', 'running');

    const opts = {
      prompt,
      options: {
        allowedTools: this.allowedTools,
        maxTurns: 50,
        maxBudgetUsd: 5.0,
        effort: 'high',
        cwd: this.cwd,
      },
    };

    if (this.sessionId) {
      opts.options.sessionId = this.sessionId;
    }

    let result = '';
    for await (const message of sdk.query(opts)) {
      if (message.type === 'assistant') {
        const text = message.message?.content
          ?.filter(b => b.type === 'text')
          ?.map(b => b.text)
          ?.join('') || '';
        if (text) {
          result += text;
          this.events.emit('output', text);
        }
      }
      if (message.type === 'result') {
        this.sessionId = message.session_id;
        if (message.subtype === 'success') {
          this.status = 'completed';
          this.lastOutput = message.result || result;
          this.events.emit('completed', this.lastOutput);
        } else {
          this.status = 'error';
          this.events.emit('error', `Stopped: ${message.subtype}`);
        }
      }
    }

    return this.lastOutput;
  }

  /**
   * Kill the running session.
   */
  kill() {
    if (this._process) {
      this._process.kill('SIGTERM');
      this._process = null;
    }
    this.status = 'idle';
  }
}

// ─── Terminal Backend Interface ────────────────────────────────────────────
// Provides the same interface as wezterm.cjs but works with multiple backends.

const BACKEND = (process.env.WEZBRIDGE_BACKEND || 'wezterm').toLowerCase();

/**
 * Get information about the current backend.
 */
function getBackendInfo() {
  return {
    backend: BACKEND,
    wezterm: BACKEND === 'wezterm',
    windowsTerminal: BACKEND === 'wt',
    headless: BACKEND === 'headless',
    available: BACKEND === 'wezterm' || isWindowsTerminalAvailable() || BACKEND === 'headless',
  };
}

module.exports = {
  // Windows Terminal
  isWindowsTerminalAvailable,
  spawnWtPane,
  splitWtPane,
  // Headless SDK
  HeadlessSession,
  // Backend info
  getBackendInfo,
  BACKEND,
  events,
};

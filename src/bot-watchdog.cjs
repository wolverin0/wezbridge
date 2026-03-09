#!/usr/bin/env node
/**
 * Watchdog for telegram-bot.cjs — auto-restarts on crash.
 * Usage: node bot-watchdog.cjs [--seed topicId:paneId:name ...]
 */
const { spawn } = require('child_process');
const path = require('path');

const BOT_SCRIPT = path.join(__dirname, 'telegram-bot.cjs');
const RESTART_DELAY_MS = 3000;
const MAX_RAPID_RESTARTS = 5;
const RAPID_WINDOW_MS = 30000;

const restartTimes = [];
let child = null;

function startBot() {
  const args = process.argv.slice(2);
  console.log(`[watchdog] Starting bot... (args: ${args.join(' ') || 'none'})`);

  child = spawn(process.execPath, [BOT_SCRIPT, ...args], {
    stdio: 'inherit',
    cwd: path.join(__dirname, '..', '..'),
  });

  child.on('exit', (code, signal) => {
    console.log(`[watchdog] Bot exited: code=${code} signal=${signal}`);

    // Track rapid restarts
    const now = Date.now();
    restartTimes.push(now);
    const recent = restartTimes.filter(t => now - t < RAPID_WINDOW_MS);
    if (recent.length > MAX_RAPID_RESTARTS) {
      console.error(`[watchdog] Too many restarts (${recent.length} in ${RAPID_WINDOW_MS / 1000}s). Giving up.`);
      process.exit(1);
    }

    console.log(`[watchdog] Restarting in ${RESTART_DELAY_MS / 1000}s...`);
    setTimeout(startBot, RESTART_DELAY_MS);
  });

  child.on('error', (err) => {
    console.error(`[watchdog] Failed to start bot:`, err.message);
  });
}

// Forward SIGINT/SIGTERM to child
process.on('SIGINT', () => {
  console.log('[watchdog] SIGINT received, stopping bot...');
  if (child) child.kill('SIGINT');
  setTimeout(() => process.exit(0), 2000);
});

process.on('SIGTERM', () => {
  console.log('[watchdog] SIGTERM received, stopping bot...');
  if (child) child.kill('SIGTERM');
  setTimeout(() => process.exit(0), 2000);
});

startBot();

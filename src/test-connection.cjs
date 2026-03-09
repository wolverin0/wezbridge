#!/usr/bin/env node
/**
 * Quick test: verifies WezTerm CLI and Telegram bot token work.
 */

async function main() {
  console.log('=== WezBridge Connection Test ===\n');

  // 1. Test WezTerm
  console.log('[1/3] Testing WezTerm CLI...');
  try {
    const wez = require('./wezterm.cjs');
    const panes = wez.listPanes();
    console.log(`  OK: ${panes.length} pane(s) found`);
    for (const p of panes) {
      console.log(`  - Pane ${p.pane_id}: ${p.title || 'untitled'}`);
    }
  } catch (err) {
    console.error(`  FAIL: ${err.message}`);
    console.error('  Make sure WezTerm is installed and the mux server is running.');
    console.error('  Try: wezterm start --front-end MuxServer');
  }

  // 2. Test Telegram token
  console.log('\n[2/3] Testing Telegram bot token...');
  const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  if (!TOKEN) {
    console.error('  SKIP: TELEGRAM_BOT_TOKEN not set');
  } else {
    try {
      const res = await fetch(`https://api.telegram.org/bot${TOKEN}/getMe`);
      const data = await res.json();
      if (data.ok) {
        console.log(`  OK: @${data.result.username} (${data.result.first_name})`);
      } else {
        console.error(`  FAIL: ${data.description}`);
      }
    } catch (err) {
      console.error(`  FAIL: ${err.message}`);
    }
  }

  // 3. Test group access
  console.log('\n[3/3] Testing group access...');
  const GROUP_ID = process.env.TELEGRAM_GROUP_ID;
  if (!TOKEN || !GROUP_ID) {
    console.error('  SKIP: TELEGRAM_BOT_TOKEN or TELEGRAM_GROUP_ID not set');
  } else {
    try {
      const res = await fetch(`https://api.telegram.org/bot${TOKEN}/getChat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: Number(GROUP_ID) }),
      });
      const data = await res.json();
      if (data.ok) {
        console.log(`  OK: "${data.result.title}" (${data.result.type})`);
        if (!data.result.is_forum) {
          console.warn('  WARNING: Group is not a forum. Enable Topics in group settings.');
        }
      } else {
        console.error(`  FAIL: ${data.description}`);
        console.error('  Make sure the bot is added to the group as admin with "Manage Topics" permission.');
      }
    } catch (err) {
      console.error(`  FAIL: ${err.message}`);
    }
  }

  console.log('\nDone.');
}

main().catch(console.error);

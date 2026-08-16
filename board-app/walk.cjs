#!/usr/bin/env node
'use strict';
/**
 * walk.cjs — the scripted real-browser walk the spec demands before any done
 * claim. Desktop 1880px + phone 390px, forced error/empty states, console
 * error capture (must be ZERO outside the forced-failure phases), PWA checks,
 * and a LAN-IP load under a phone user-agent.
 *
 *   node walk.cjs            # writes screenshots + walk-report.json to ../.orchestrator/T-0140-shots/
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const BASE = 'http://127.0.0.1:4272';
const OUT = path.join(__dirname, '..', '.orchestrator', 'T-0140-shots');
const TOKEN = fs.readFileSync(path.join(__dirname, '.env.local'), 'utf8').match(/BOARD_TOKEN=(.+)/)[1].trim();

const report = { started_at: new Date().toISOString(), steps: [], console_errors_clean_phases: [], lan: null };

function lanIp() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces) {
      if (i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254')) return i.address;
    }
  }
  return null;
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false });
  report.steps.push(name);
  console.log(`✓ ${name}`);
}

function watchConsole(page, phase) {
  page.on('console', (msg) => {
    if (msg.type() === 'error') report.console_errors_clean_phases.push({ phase: phase.value, text: msg.text() });
  });
  page.on('pageerror', (err) => report.console_errors_clean_phases.push({ phase: phase.value, text: String(err) }));
}

async function enterToken(page, token) {
  await page.fill('#token', token);
  await page.click('button[type=submit]');
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();

  // ------------------------------------------------------------- desktop
  const desktop = await browser.newContext({ viewport: { width: 1880, height: 1000 } });
  const page = await desktop.newPage();
  const phase = { value: 'desktop-clean' };
  watchConsole(page, phase);

  await page.goto(BASE);
  await page.waitForSelector('#token');
  await shot(page, '01-token-gate-1880');

  await enterToken(page, 'wrong-token-on-purpose');
  await page.waitForSelector('[role=alert]');
  await shot(page, '02-token-gate-error-1880');

  await enterToken(page, TOKEN);
  await page.waitForSelector('.decision', { timeout: 15000 });
  await shot(page, '03-cockpit-1880');

  // defer menu open
  await page.click('.decision .defer-wrap > button');
  await page.waitForSelector('.defer-menu');
  await shot(page, '04-defer-menu-1880');
  await page.keyboard.press('Escape');
  await page.click('body', { position: { x: 900, y: 80 } });

  // note composer open
  await page.click('.decision .btn.ghost');
  await page.waitForSelector('.composer textarea');
  await shot(page, '05-note-composer-1880');
  await page.click('.composer .btn.ghost'); // Volver

  // activity filter toggled
  await page.click('.feed-filters button:first-child');
  await shot(page, '06-activity-filtered-1880');
  await page.click('.feed-filters button:first-child');

  // ---------------------------------------------- forced error (documented)
  phase.value = 'desktop-forced-error';
  await desktop.route('**/api/state', (r) => r.abort());
  await page.reload();
  await page.waitForSelector('.error-box', { timeout: 15000 });
  await shot(page, '07-forced-error-1880');
  await desktop.unroute('**/api/state');

  // ---------------------------------------------- forced empty (documented)
  phase.value = 'desktop-forced-empty';
  const emptyState = {
    generated_at: new Date().toISOString(),
    gate: { verdict: 'GREEN', unruled: 0, last_run_at: new Date().toISOString(), last_run_text: 'steward-gate GREEN' },
    last_turn_at: new Date().toISOString(), snapshot_at: null,
    decisions: [], last_ruling: { task: 'T-0139', category: 'idle', ruling: 'cancelled', why: 'zombie purge', at: new Date(Date.now() - 3600000).toISOString() },
    in_flight: [], by_repo: {}, routines: [], sparkline: new Array(24).fill(0), open_count: 0, findings_list: [],
    kitchen: { status: 'unconfigured' },
  };
  await desktop.route('**/api/state', (r) => r.fulfill({ json: emptyState }));
  await page.reload();
  await page.waitForSelector('.empty', { timeout: 15000 });
  await shot(page, '08-forced-empty-1880');
  await desktop.unroute('**/api/state');

  // ------------------------------------------------------------ PWA checks
  phase.value = 'pwa';
  const manifest = await page.evaluate(async () => {
    const res = await fetch('/manifest.webmanifest');
    return { status: res.status, body: await res.json() };
  });
  const icons = await page.evaluate(async () => {
    const a = await fetch('/icon-192.png'); const b = await fetch('/icon-512.png');
    return [a.status, b.status];
  });
  await page.reload();
  await page.waitForSelector('.decision, .empty', { timeout: 15000 });
  const sw = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return { supported: false };
    const reg = await navigator.serviceWorker.ready;
    const cacheKeys = await caches.keys();
    return { supported: true, scope: reg.scope, active: Boolean(reg.active), caches: cacheKeys };
  });
  report.pwa = { manifest_status: manifest.status, manifest_name: manifest.body.name, icons, sw };

  await desktop.close();

  // -------------------------------------------------------------- phone 390
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
    isMobile: true, hasTouch: true,
  });
  const p2 = await phone.newPage();
  const phase2 = { value: 'phone-clean' };
  watchConsole(p2, phase2);

  await p2.goto(BASE);
  await p2.waitForSelector('#token');
  await shot(p2, '10-token-gate-390');
  await enterToken(p2, TOKEN);
  await p2.waitForSelector('.decision', { timeout: 15000 });
  await shot(p2, '11-decisiones-tab-390');

  await p2.click('.tabs-nav button:nth-child(2)');
  await p2.waitForSelector('.spark');
  await shot(p2, '12-flota-tab-390');

  await p2.click('.tabs-nav button:nth-child(3)');
  await p2.waitForSelector('.feed-item, .empty');
  await shot(p2, '13-actividad-tab-390');

  await p2.click('.tabs-nav button:nth-child(1)');
  await p2.click('.decision .defer-wrap > button');
  await p2.waitForSelector('.defer-menu');
  await shot(p2, '14-defer-menu-390');

  await phone.close();

  // ------------------------------------------------- LAN IP + phone UA load
  const ip = lanIp();
  if (ip) {
    const lan = await browser.newContext({
      viewport: { width: 390, height: 844 },
      userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
    });
    const p3 = await lan.newPage();
    const res = await p3.goto(`http://${ip}:4272/`);
    await p3.waitForSelector('#token');
    await shot(p3, `15-lan-ip-390`);
    report.lan = { ip, status: res.status(), note: 'SW/install requires secure context; over plain-http LAN the app runs but Chrome will not offer install. Documented in STATE.md.' };
    await lan.close();
  }

  await browser.close();
  report.finished_at = new Date().toISOString();
  fs.writeFileSync(path.join(OUT, 'walk-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    steps: report.steps.length,
    console_errors: report.console_errors_clean_phases,
    pwa: report.pwa,
    lan: report.lan,
  }, null, 2));
})().catch((e) => { console.error('WALK FAILED:', e); process.exit(1); });

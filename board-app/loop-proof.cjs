#!/usr/bin/env node
'use strict';
/**
 * loop-proof.cjs — exit criterion 2, live. Rules the two findings pane-0
 * designated (2026-08-16, corr T-0140-fleet-board-app) through the REAL UI:
 *   desktop 1880px → T-0031 deferred until 2026-08-23T09:00:00.000Z
 *   phone   390px  → T-0013 deferred until 2026-08-23T09:00:00.000Z
 * then verifies the exact lines on disk and that steward-gate still judges
 * them correctly (deferred = covered until `until`).
 */
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const BASE = 'http://127.0.0.1:4272';
const OUT = path.join(__dirname, '..', '.orchestrator', 'T-0140-shots');
const INTEL = path.join(__dirname, '..', '..', '_intel');
const TOKEN = fs.readFileSync(path.join(__dirname, '.env.local'), 'utf8').match(/BOARD_TOKEN=(.+)/)[1].trim();

// Local datetime 06:00 in America/Buenos_Aires (UTC-3, no DST) = 09:00Z.
const UNTIL_LOCAL = '2026-08-23T06:00';
const UNTIL_ISO = '2026-08-23T09:00:00.000Z';

const RULINGS = [
  {
    task: 'T-0031', viewport: { width: 1880, height: 1000 }, label: 'desktop',
    why: 'graphify-regen for whatsappbot batches behind T-0140/T-0141 hardening; re-run after board app lands',
  },
  {
    task: 'T-0013', viewport: { width: 390, height: 844 }, label: 'phone', mobile: true,
    why: 'config-fix batches with the same sweep; deferred while board app + Phase 1 land',
  },
];

async function ruleOne(browser, spec, shotPrefix) {
  const ctx = await browser.newContext({
    viewport: spec.viewport,
    ...(spec.mobile ? {
      isMobile: true, hasTouch: true,
      userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
    } : {}),
  });
  const page = await ctx.newPage();
  await page.goto(BASE);
  await page.fill('#token', TOKEN);
  await page.click('button[type=submit]');
  await page.waitForSelector('.decision', { timeout: 15000 });

  const card = page.locator(`.decision:has-text("${spec.task}")`).first();
  await card.scrollIntoViewIfNeeded();
  await card.locator('.defer-wrap > button').click();
  await card.locator('input[type=datetime-local]').fill(UNTIL_LOCAL);
  await page.screenshot({ path: path.join(OUT, `${shotPrefix}-defer-custom.png`) });
  await card.locator('.custom .btn').click();
  await card.locator('textarea').fill(spec.why);
  await page.screenshot({ path: path.join(OUT, `${shotPrefix}-composer.png`) });
  await card.locator('.composer .btn.primary').click();
  await page.waitForSelector('.toast.ok', { timeout: 15000 });
  await page.screenshot({ path: path.join(OUT, `${shotPrefix}-toast.png`) });
  const toastLine = await page.locator('.toast.ok .line').textContent();
  await ctx.close();
  return JSON.parse(toastLine);
}

(async () => {
  const browser = await chromium.launch();
  const results = [];
  for (const spec of RULINGS) {
    const line = await ruleOne(browser, spec, `20-loop-${spec.label}-${spec.task}`);
    results.push({ spec: spec.task, viewport: spec.label, toast_line: line });
    console.log(`✓ ${spec.label} ruled ${spec.task}: ${JSON.stringify(line)}`);
  }
  await browser.close();

  // -------- disk verification: exact schema, exact values
  const onDisk = fs.readFileSync(path.join(INTEL, 'rulings.jsonl'), 'utf8').trim().split('\n')
    .map((l) => JSON.parse(l));
  for (const r of results) {
    const line = [...onDisk].reverse().find((x) => x.task === r.spec);
    if (!line) throw new Error(`no ruling on disk for ${r.spec}`);
    const errs = [];
    if (line.ruling !== 'deferred') errs.push(`ruling=${line.ruling}`);
    if (line.category !== 'idle') errs.push(`category=${line.category}`);
    if (line.until !== UNTIL_ISO) errs.push(`until=${line.until}`);
    if (JSON.stringify(line) !== JSON.stringify(r.toast_line)) errs.push('toast line differs from disk line');
    if (errs.length) throw new Error(`${r.spec}: ${errs.join('; ')}`);
    console.log(`✓ disk line schema-exact for ${r.spec}: ${JSON.stringify(line)}`);
  }

  // -------- gate verification: still judges correctly with the new cover
  const { rulingCovers } = require(path.join(__dirname, '..', 'scripts', 'steward-gate.cjs'));
  for (const r of results) {
    const line = [...onDisk].reverse().find((x) => x.task === r.spec);
    const finding = { id: r.spec, category: 'idle', age_hours: 500 };
    if (!rulingCovers(line, finding, Date.now())) throw new Error(`${r.spec} not covered NOW`);
    if (rulingCovers(line, finding, Date.parse(UNTIL_ISO) + 60000)) throw new Error(`${r.spec} still covered AFTER until`);
    console.log(`✓ gate covers ${r.spec} now, re-raises after ${UNTIL_ISO}`);
  }
  console.log('LOOP PROOF COMPLETE');
})().catch((e) => { console.error('LOOP PROOF FAILED:', e); process.exit(1); });

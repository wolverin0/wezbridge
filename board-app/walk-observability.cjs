#!/usr/bin/env node
'use strict';
/**
 * walk-observability.cjs — the scripted real-browser walk for the six
 * observability panels added 2026-08-23, in the shape walk.cjs established for
 * T-0140: desktop 1880 + phone 390, FORCED error/empty states, console errors
 * captured and required to be zero in the clean phases.
 *
 * It reads the board token off disk itself. That is not incidental: it means a
 * validation run never has to echo the token through an agent transcript.
 *
 * Drives the SYSTEM Chrome via playwright-core (no bundled-browser download) —
 * this repo does not carry heavy deps and a 150 MB browser for a screenshot run
 * would be exactly that.
 *
 *   node walk-observability.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');

const BASE = 'http://127.0.0.1:4272';
const OUT = path.join(__dirname, '..', '.orchestrator', 'T-0192-obs-shots');
const TOKEN = fs.readFileSync(path.join(__dirname, '.env.local'), 'utf8').match(/BOARD_TOKEN=(.+)/)[1].trim();

const report = { started_at: new Date().toISOString(), shots: [], checks: [], console_errors: [] };
let phase = 'init';

function check(name, pass, evidence) {
  report.checks.push({ name, pass, evidence: String(evidence).slice(0, 300) });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  ${String(evidence).slice(0, 160)}`);
}

async function shot(page, name) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  report.shots.push(file);
  console.log(`shot  ${name}`);
}

function watch(page) {
  page.on('console', (m) => {
    if (m.type() === 'error') report.console_errors.push({ phase, text: m.text() });
  });
  page.on('pageerror', (e) => report.console_errors.push({ phase, text: String(e) }));
}

async function auth(page) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#token');
  await page.fill('#token', TOKEN);
  await page.click('button[type=submit]');
  // NOT `.segmented`: at 390px it lives inside the FLOTA zone, which is
  // display:none until its bottom-nav tab is chosen, so waiting for it to be
  // VISIBLE hangs forever on the phone. Wait for the zones to exist and the
  // loading skeletons to clear instead — that is "the board is up" at any width.
  await page.waitForSelector('.zones', { timeout: 20000 });
  await page.waitForFunction(() => document.querySelectorAll('.skeleton').length === 0, null, { timeout: 20000 });
}

/** Click one of the FLOTA sub-views by its visible label. */
async function sub(page, label) {
  await page.click(`.segmented button:text-is("${label}")`);
  await page.waitForTimeout(400);
}

const textOf = (page, sel) => page.$eval(sel, (e) => e.innerText).catch(() => '');

/**
 * Forced states. The panels are rewritten IN FLIGHT rather than by touching
 * _intel: the control plane is never a test fixture, and a walk that mutated it
 * to see a red panel would be the worst possible way to prove error handling.
 */
async function forceStates(page, mutate) {
  await page.route('**/api/state', async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    mutate(body);
    await route.fulfill({ response: res, body: JSON.stringify(body) });
  });
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome' });

  // ─────────────────────────────────────────────────────────────── desktop
  const desktop = await browser.newContext({ viewport: { width: 1880, height: 1080 } });
  const page = await desktop.newPage();
  watch(page);

  phase = 'desktop-clean';
  await auth(page);
  await shot(page, '01-cockpit-1880');

  // ACCIONES FIRMADAS lives in the always-visible right zone.
  const actions = await textOf(page, 'section[aria-label=Actividad]');
  check('acciones firmadas visible sin clics (zona Actividad)',
    /Qui[eé]n hizo qu[eé]/i.test(actions), actions.split('\n').slice(0, 3).join(' | '));
  const actionRows = await page.$$eval('.actions-tbl tbody tr', (r) => r.length);
  check('acciones firmadas trae filas reales', actionRows > 0, `${actionRows} filas`);
  // Regression guard for the 2026-08-23 walk finding: the `target` column holds
  // Windows paths, and with an auto table layout they pushed the table past the
  // narrow right zone so the last column was clipped off the viewport.
  const fit = await page.$eval('.actions-tbl', (t) => ({ table: t.scrollWidth, zone: t.closest('section').clientWidth }));
  check('acciones firmadas entra en la columna angosta (sin recorte)', fit.table <= fit.zone, JSON.stringify(fit));

  phase = 'desktop-motor';
  await sub(page, 'Motor');
  await shot(page, '02-motor-1880');
  const motor = await textOf(page, 'section[aria-label=Flota]');
  // The headings render UPPERCASE (text-transform on `.section > h3`), so
  // innerText comes back uppercase and every match here is case-insensitive.
  // "Colas por proyecto" is additionally anchored to a line start: that exact
  // phrase also appears inside the rollup markdown rendered above it, and an
  // unanchored match passed while the panel itself was absent.
  check('panel Rollup del día', /Rollup del d[ií]a/i.test(motor), (motor.match(/Rollup del d[ií]a[^\n]*/i) || [''])[0]);
  check('panel Motor de turnos', /Motor de turnos/i.test(motor), (motor.match(/Motor de turnos[^\n]*/i) || [''])[0]);
  check('panel Colas por proyecto', /^\s*COLAS POR PROYECTO/im.test(motor), (motor.match(/^\s*COLAS POR PROYECTO[^\n]*/im) || [''])[0]);
  check('panel Tareas programadas', /Tareas programadas/i.test(motor), (motor.match(/Tareas programadas[^\n]*/i) || [''])[0]);

  const bars = await page.$$eval('.bar-row', (rows) => rows.map((r) => r.innerText.replace(/\n/g, ' ')));
  check('histograma de clases con las cuatro clases', bars.length === 4, bars.join(' // '));
  const barValues = await page.$$eval('.bar-value', (n) => n.map((x) => Number(x.innerText)));
  check('histograma con datos reales (no todo cero)', barValues.some((v) => v > 0), JSON.stringify(barValues));

  // Scroll the zone so the census (last panel) is captured too.
  await page.$eval('section[aria-label=Flota]', (el) => { el.scrollTop = el.scrollHeight; });
  await page.waitForTimeout(300);
  await shot(page, '03-motor-census-1880');
  const silentTag = await page.$$eval('.tag.census-silent-failure', (n) => n.map((x) => x.innerText));
  check('census marca la FALLA SILENCIOSA', silentTag.length > 0, silentTag.join(', ') || 'ninguna');
  const censusRows = await page.$$eval('.section:last-child tbody tr', (r) => r.length).catch(() => 0);
  check('census trae filas', censusRows > 0, `${censusRows} filas`);

  phase = 'desktop-bots';
  await sub(page, 'Bots');
  await page.$eval('section[aria-label=Flota]', (el) => { el.scrollTop = 0; });
  await page.waitForTimeout(300);
  await shot(page, '04-bots-1880');
  const bots = await textOf(page, 'section[aria-label=Flota]');
  check('brief del centinela renderizado', /CENTINELA/.test(bots), (bots.match(/CENTINELA[^\n]*/) || [''])[0]);
  check('brief del sensor de flota renderizado', /Fleet sensor|Sensor de flota/i.test(bots),
    (bots.match(/(Fleet sensor|Sensor de flota)[^\n]*/i) || [''])[0]);
  check('ticker de los bots con su cadencia', /Ticker de los bots/i.test(bots) && /every \d+m/.test(bots),
    (bots.match(/every \d+m/) || [''])[0]);

  const cleanErrors = report.console_errors.length;
  check('CERO errores de consola en las fases limpias', cleanErrors === 0,
    cleanErrors ? JSON.stringify(report.console_errors) : 'ninguno');

  // ───────────────────────────────────────────────── forced error / empty
  phase = 'desktop-forced';
  const forced = await browser.newContext({ viewport: { width: 1880, height: 1080 } });
  const fp = await forced.newPage();
  watch(fp);
  await forceStates(fp, (b) => {
    const o = b.observability;
    o.actions = { generated_at: o.actions.generated_at, error: 'ENOENT: actions.jsonl no existe' };
    o.queues = { generated_at: o.queues.generated_at, projects: [], flags: 0, pending: 0, total_undelivered: 0 };
    o.rollup = { generated_at: o.rollup.generated_at, newest: null, newest_date: null, expected: '2026-08-23', ran: false, text: null, next_run_local: '02:30' };
    o.waker = { generated_at: o.waker.generated_at, error: 'EACCES: turns/ ilegible' };
    o.census = { status: 'error', generated_at: o.census.generated_at, items: [], silent: [], error: 'schtasks exited 1' };
    o.briefs.items = o.briefs.items.map((i) => ({ ...i, missing: true, text: null, last_run_at: null }));
  });
  await auth(fp);
  await sub(fp, 'Motor');
  await shot(fp, '05-motor-estados-forzados-1880');
  const forcedMotor = await textOf(fp, 'section[aria-label=Flota]');
  check('fuente rota se declara rota (waker)', /No se pudo leer esta fuente/i.test(forcedMotor),
    (forcedMotor.match(/No se pudo leer esta fuente[^\n]*/) || [''])[0]);
  check('rollup ausente dice cuándo corre', /todavía no corrió/i.test(forcedMotor),
    (forcedMotor.match(/[^\n]*todavía no corrió[^\n]*/i) || [''])[0]);
  check('colas vacías muestran el estado normal, no un cero mudo',
    /Ninguna cola tiene actividad/i.test(forcedMotor), 'empty state OK');
  check('census roto no finge verde', /No se pudo leer esta fuente|no respondió/.test(forcedMotor), 'census error OK');
  const forcedActions = await textOf(fp, 'section[aria-label=Actividad]');
  check('acciones rotas se declaran rotas', /No se pudo leer esta fuente/i.test(forcedActions), 'actions error OK');

  await sub(fp, 'Bots');
  await shot(fp, '06-bots-estado-vacio-1880');
  const forcedBots = await textOf(fp, 'section[aria-label=Flota]');
  check('brief ausente se lee como buena noticia, no como falla',
    /Nada que reportar/i.test(forcedBots) && /buena noticia/.test(forcedBots), 'empty state OK');

  // ───────────────────────────────────────────────────────────────── phone
  phase = 'phone';
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36',
  });
  const pp = await phone.newPage();
  watch(pp);
  await auth(pp);
  await pp.click('.tabs-nav button:has-text("Flota")');
  await pp.waitForTimeout(300);
  await sub(pp, 'Motor');
  await shot(pp, '07-motor-390');
  const pMotor = await textOf(pp, 'section[aria-label=Flota]');
  check('phone: el motor entra en 390px', /Motor de turnos/i.test(pMotor), 'ok');
  const overflow = await pp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  check('phone: sin scroll horizontal', overflow,
    await pp.evaluate(() => `scrollWidth=${document.documentElement.scrollWidth} inner=${window.innerWidth}`));

  await sub(pp, 'Bots');
  await shot(pp, '08-bots-390');
  await pp.click('.tabs-nav button:has-text("Actividad")');
  await pp.waitForTimeout(300);
  await shot(pp, '09-acciones-390');
  const pAct = await textOf(pp, 'section[aria-label=Actividad]');
  check('phone: quién hizo qué accesible en una pestaña', /Qui[eé]n hizo qu[eé]/i.test(pAct), 'ok');
  const pFit = await pp.$eval('.actions-tbl', (t) => ({ table: t.scrollWidth, zone: t.closest('section').clientWidth }));
  check('phone: acciones firmadas sin recorte', pFit.table <= pFit.zone, JSON.stringify(pFit));

  report.finished_at = new Date().toISOString();
  report.console_errors_total = report.console_errors.length;
  report.passed = report.checks.filter((c) => c.pass).length;
  report.failed = report.checks.filter((c) => !c.pass).length;
  fs.writeFileSync(path.join(OUT, 'walk-report.json'), JSON.stringify(report, null, 2));
  await browser.close();

  console.log(`\n${report.passed} passed, ${report.failed} failed, ${report.console_errors.length} console errors`);
  console.log(`shots + report: ${OUT}`);
  process.exit(report.failed === 0 && report.console_errors.length === 0 ? 0 : 1);
})().catch((e) => { console.error('WALK CRASHED:', e); process.exit(2); });

#!/usr/bin/env node
'use strict';
/**
 * walk-0143.cjs — the real-browser proof for T-0143's three defects.
 *
 * Two targets on purpose:
 *
 *   PART A (sandbox, :4273, temp _intel): the destructive verbs. Cancelling and
 *   approving MOVE TASK STATE, so proving them against the live control plane
 *   would mean seeding fake gated tasks into `_intel/tasks/` and mutating real
 *   fleet rows to produce a screenshot. The server is booted IN THIS PROCESS
 *   against a temp intel dir — no stray node, no write outside the sandbox.
 *
 *   PART B (live, :4272, read-only): the D3 detail panel on tasks whose text is
 *   genuinely long and real (T-0008, T-0105). A panel that only ever renders
 *   fixture prose has not been tested on the thing it exists for.
 *
 *   node walk-0143.cjs   # → ../.orchestrator/T-0143-shots/
 *
 * wezbridge has no playwright of its own and the zero-dependency rule is worth
 * keeping, so the driver is borrowed from a sibling project's node_modules.
 * Override with WALK_PLAYWRIGHT if that project ever moves.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const OUT = path.join(__dirname, '..', '.orchestrator', 'T-0143-shots');
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'board-0143-'));
process.env.WEZBRIDGE_INTEL_DIR = SANDBOX;

const PW = process.env.WALK_PLAYWRIGHT
  || path.join(__dirname, '..', '..', 'app', 'node_modules', 'playwright');
const { chromium } = require(PW);
const srv = require('./server.cjs');

const TOKEN = 'walk-0143-token';
const LIVE = 'http://127.0.0.1:4272';
const LIVE_TOKEN = fs.readFileSync(path.join(__dirname, '.env.local'), 'utf8').match(/BOARD_TOKEN=(.+)/)[1].trim();

const report = { started_at: new Date().toISOString(), shots: [], checks: [], console_errors: [] };
const iso = (d) => new Date(d).toISOString();

function check(name, pass, evidence) {
  report.checks.push({ name, pass, evidence });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name} — ${evidence}`);
  if (!pass) process.exitCode = 1;
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false });
  report.shots.push(name);
  console.log(`  shot ${name}`);
}

function watchConsole(page, phase) {
  page.on('console', (m) => { if (m.type() === 'error') report.console_errors.push({ phase: phase.value, text: m.text() }); });
  page.on('pageerror', (e) => report.console_errors.push({ phase: phase.value, text: String(e) }));
}

const LONG_QUESTION = 'El pool de candidatos tiene CERO frames de tarde (118 mañana / 62 tarde / 60 madrugada), '
  + 'asi que un gate de cuatro condiciones es aritmeticamente inalcanzable sin capturar la franja que falta. '
  + 'Ademas, un humano verificando borradores de IA caza falsos positivos con facilidad y falsos negativos casi nunca, '
  + 'asi que escalar borradores arriesga convertir ground truth aprobado por humanos en salida de IA con firma. '
  + 'Relajar el gate a tres condiciones es TU decision, no la del pane.';

function seed(id, extra = {}) {
  const now = Date.now();
  const task = {
    id,
    origin_key: null,
    title: `Drive to the 200-frame human gate: evening stratum + Codex-assisted annotation (${id})`,
    goal: 'End goal is the roadmap gate: 200 human-approved frames across four operating conditions. '
      + 'Codex drafting turns the human job from authoring into verifying, which is what makes 200 reachable.',
    kind: 'general',
    repo: 'yolo26',
    state: 'blocked',
    lease: { owner: 'pane-31', expires_at: iso(now + 3600000) },
    acceptance_criteria: [
      'EVENING STRATUM FIRST: capture it, or report explicitly that it is blocked with the reason',
      'per-batch review telemetry split three ways: boxes EDITED, DELETED, and ADDED by the human — per class, not only in total',
      'thresholds PRE-REGISTERED before the first batch, with a stated do-not-scale outcome that counts as a full result',
      'AI-reviewed labels NEVER count toward the 200-frame human gate',
    ],
    context_refs: ['_intel/briefs/yolo26-annotation-scaleup-20260813.md', 'ROADMAP.md'],
    depends_on: ['T-9800'],
    corr: 'yolo26-annot-20260813',
    contract: { mode: 'scoped_write', gate: 'operator', allowed_paths: ['src/**', 'tests/**'], _note: 'fallback note' },
    blocker: LONG_QUESTION,
    next_action: null,
    attempt: 1,
    created_at: iso(now - 7200000),
    updated_at: iso(now - 3600000),
    ...extra,
  };
  fs.writeFileSync(path.join(SANDBOX, 'tasks', `${id}.json`), JSON.stringify(task, null, 2));
  return task;
}

const readTask = (id) => JSON.parse(fs.readFileSync(path.join(SANDBOX, 'tasks', `${id}.json`), 'utf8'));

async function enterToken(page, token) {
  await page.fill('#token', token);
  await page.click('button[type=submit]');
}

/** Drive one decision card through a verb, exactly as the operator does. */
async function rule(page, id, buttonName, note, opts = {}) {
  const card = page.locator('.decision').filter({ hasText: id }).first();
  if (opts.defer) {
    await card.locator('.defer-wrap > button').click();
    await card.locator('.defer-menu button', { hasText: '1 semana' }).first().click();
  } else {
    await card.locator('button', { hasText: buttonName }).first().click();
  }
  await card.locator('.composer textarea').fill(note);
  await card.locator('.composer .btn.primary').click();
  // Toasts stack and live 8s, so the newest is the LAST one, not the first.
  await page.locator('.toast').filter({ hasText: id }).first().waitFor({ timeout: 15000 });
  return page.locator('.toast').filter({ hasText: id }).first().innerText();
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(path.join(SANDBOX, 'tasks'), { recursive: true });

  seed('T-9801');                                    // cancel
  seed('T-9802');                                    // approve
  seed('T-9803');                                    // defer
  seed('T-9804');                                    // half-success (file removed below)
  seed('T-9810', {                                   // FLOTA row, ungated
    state: 'ready', lease: null,
    contract: { mode: 'read_mostly', gate: null, allowed_paths: ['docs/**'] },
    blocker: null,
    next_action: 'Fleet owner selects the single write-time enforcement boundary. DESIGN ANALYSIS: the three '
      + 'options differ in what BYPASSES them, not in effort. (a) a PreToolUse hook is pre-emptive but blind to '
      + 'Codex panes; (b) a repo-side pre-commit guard is local and fast, but --no-verify walks past it; (c) a CI '
      + 'diff check is unbypassable by a pane but catches violations after the write.',
  });

  const server = srv.createServer(TOKEN);
  await new Promise((r) => server.listen(4273, '127.0.0.1', r));
  const BASE = 'http://127.0.0.1:4273';
  const browser = await chromium.launch();

  // =========================================================== PART A — verbs
  const desktop = await browser.newContext({ viewport: { width: 1880, height: 1000 } });
  const page = await desktop.newPage();
  const phase = { value: 'A-desktop' };
  watchConsole(page, phase);

  await page.goto(BASE);
  await page.waitForSelector('#token');
  await enterToken(page, TOKEN);
  await page.waitForSelector('.decision', { timeout: 15000 });
  await shot(page, '01-before-1880');
  check('4 gated cards on screen before any ruling',
    (await page.locator('.decision').count()) >= 4,
    `${await page.locator('.decision').count()} cards`);

  // --- D3: the decision card shows the blocker in full, and expands ---------
  const q = await page.locator('.decision').filter({ hasText: 'T-9801' }).first().locator('.question').innerText();
  check('decision card shows the blocker IN FULL, not truncated',
    q.includes('Relajar el gate a tres condiciones es TU decision'),
    `question renders ${q.length} of ${LONG_QUESTION.length} chars, ending intact`);

  await page.locator('.decision').filter({ hasText: 'T-9801' }).first()
    .locator('button', { hasText: 'Ver detalle' }).click();
  await page.waitForSelector('.tdetail');
  await shot(page, '02-decision-detail-1880');
  check('decision detail panel lists acceptance criteria',
    (await page.locator('.tdetail .crit li').count()) === 4,
    `${await page.locator('.tdetail .crit li').count()} criteria rendered`);

  // --- D1 + D2: CANCEL ------------------------------------------------------
  const cancelToast = await rule(page, 'T-9801', 'Cancelar', 'no lo necesitamos mas');
  await shot(page, '03-cancel-toast-1880');
  check('D2: cancel toast is unambiguous es-AR and never says "fallo"',
    cancelToast.includes('T-9801 cancelada.') && !/fallo/i.test(cancelToast),
    JSON.stringify(cancelToast.split('\n')[0]));
  check('D1: cancel moved the task to cancelled',
    readTask('T-9801').state === 'cancelled',
    `state=${readTask('T-9801').state}, next_action="${readTask('T-9801').next_action.slice(0, 80)}…"`);

  // --- D1: APPROVE ----------------------------------------------------------
  const approveToast = await rule(page, 'T-9802', 'Aprobar', 'dale, arranca');
  await shot(page, '04-approve-toast-1880');
  check('D2: approve toast names the consequence',
    approveToast.includes('T-9802 aprobada — pasa a la cola de trabajo.') && !/fallo/i.test(approveToast),
    JSON.stringify(approveToast.split('\n')[0]));
  check('D1: approve moved the task to ready AND un-gated it',
    readTask('T-9802').state === 'ready' && readTask('T-9802').contract.gate === null
      && readTask('T-9802').contract.mode === 'scoped_write',
    `state=${readTask('T-9802').state} gate=${readTask('T-9802').contract.gate} mode kept=${readTask('T-9802').contract.mode}`);

  // --- D1: DEFER ------------------------------------------------------------
  const deferToast = await rule(page, 'T-9803', null, 'la semana que viene', { defer: true });
  await shot(page, '05-defer-toast-1880');
  check('D2: defer toast carries the date and never says "fallo"',
    /T-9803 diferida hasta /.test(deferToast) && !/fallo/i.test(deferToast),
    JSON.stringify(deferToast.split('\n')[0]));
  check('D1: defer left the task state alone — it is still legitimately gated',
    readTask('T-9803').state === 'blocked',
    `state=${readTask('T-9803').state}`);

  // --- half-success: the ruling stands, the task does not move --------------
  // The card for T-9804 is on screen from the last refresh. Removing the file
  // underneath it is the honest simulation of the write failing at the moment
  // the operator commits — the ruling must land and the UI must NOT claim a
  // clean success.
  const rulingsBefore = fs.readFileSync(path.join(SANDBOX, 'rulings.jsonl'), 'utf8').trim().split('\n').length;
  fs.rmSync(path.join(SANDBOX, 'tasks', 'T-9804.json'));
  await rule(page, 'T-9804', 'Cancelar', 'la tarea desaparecio del disco');
  await page.locator('.toast.warn').waitFor({ timeout: 15000 });
  await shot(page, '06-half-success-warn-1880');

  const rulingsAfter = fs.readFileSync(path.join(SANDBOX, 'rulings.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  check('failure path: the ruling STANDS even though the task write failed',
    rulingsAfter.length === rulingsBefore + 1 && rulingsAfter.at(-1).task === 'T-9804',
    `rulings ${rulingsBefore} → ${rulingsAfter.length}, last=${rulingsAfter.at(-1).ruling}:${rulingsAfter.at(-1).task}`);
  const warnText = await page.locator('.toast.warn').innerText();
  check('failure path: the UI says which half happened, and says not to resend',
    /quedó registrada/.test(warnText) && /NO se movió/.test(warnText) && /No la vuelvas a mandar/.test(warnText),
    JSON.stringify(warnText.slice(0, 130)));

  // --- the cards are GONE on refresh — the whole point of D1 ----------------
  await page.reload();
  await page.waitForSelector('.zone', { timeout: 15000 });
  await page.waitForSelector('.empty, .decision', { timeout: 15000 });
  const visible = await page.locator('.decision').allInnerTexts();
  const stillThere = ['T-9801', 'T-9802', 'T-9803'].filter((id) => visible.some((t) => t.includes(id)));
  check('D1 THE DEFECT: cancelled / approved / deferred cards are all GONE on refresh',
    stillThere.length === 0,
    stillThere.length ? `still on screen: ${stillThere.join(',')}` : 'none of the three remain');
  check('deferred is HIDDEN, not silently gone: the count is on screen',
    (await page.locator('.deferred-note').count()) === 1
      && (await page.locator('.deferred-note').innerText()).includes('1 diferida'),
    (await page.locator('.deferred-note').innerText()).split('\n')[0]);
  await shot(page, '07-after-all-three-1880');
  await desktop.close();

  // ------------------------------------------------------------- phone 390
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
    isMobile: true, hasTouch: true,
  });
  const p2 = await phone.newPage();
  const phase2 = { value: 'A-phone' };
  watchConsole(p2, phase2);
  await p2.goto(BASE);
  await p2.waitForSelector('#token');
  await enterToken(p2, TOKEN);
  await p2.waitForSelector('.zone.active', { timeout: 15000 });
  await shot(p2, '08-decisiones-after-390');

  await p2.click('.tabs-nav button:nth-child(2)');
  await p2.waitForSelector('.spark');
  const row = p2.locator('.task-row').filter({ hasText: 'T-9810' }).first();
  await row.click();
  await p2.waitForSelector('.tdetail');
  await shot(p2, '09-flota-detail-390');
  check('D3 phone: an expanded row shows goal + next_action, wrapped not clamped',
    (await p2.locator('.tdetail .prose').first().innerText()).length > 100,
    `first prose block renders ${(await p2.locator('.tdetail .prose').first().innerText()).length} chars`);

  await phone.close();
  server.close();

  // ========================================== PART B — the LIVE board, real text
  const livePhase = { value: 'B-live' };
  const liveDesktop = await browser.newContext({ viewport: { width: 1880, height: 1000 } });
  const lp = await liveDesktop.newPage();
  watchConsole(lp, livePhase);
  await lp.goto(LIVE);
  await lp.waitForSelector('#token');
  await enterToken(lp, LIVE_TOKEN);
  await lp.waitForSelector('.zone', { timeout: 15000 });
  await lp.click('.filter-row input[type=search]');
  await lp.fill('.filter-row input[type=search]', 'T-0105');
  await lp.waitForTimeout(300);
  await lp.locator('.task-row').filter({ hasText: 'T-0105' }).first().click();
  await lp.waitForSelector('.tdetail');
  await shot(lp, '10-live-T-0105-detail-1880');
  const realText = await lp.locator('.tdetail').first().innerText();
  check('D3 live 1880: a real long-text task renders its full next_action',
    realText.includes('DEPENDS ON T-0106') && realText.includes('pre-commit'),
    `panel renders ${realText.length} chars including the tail of a 1.3k-char next_action`);
  check('D3 live: acceptance criteria are a list, not a blob',
    (await lp.locator('.tdetail .crit li').count()) === 5,
    `${await lp.locator('.tdetail .crit li').count()} criteria for T-0105`);

  await lp.fill('.filter-row input[type=search]', 'T-0008');
  await lp.waitForTimeout(300);
  await lp.locator('.task-row').filter({ hasText: 'T-0008' }).first().click();
  await lp.waitForSelector('.tdetail');
  await shot(lp, '11-live-T-0008-detail-1880');
  await liveDesktop.close();

  const livePhone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
    isMobile: true, hasTouch: true,
  });
  const lp2 = await livePhone.newPage();
  watchConsole(lp2, { value: 'B-live-phone' });
  await lp2.goto(LIVE);
  await lp2.waitForSelector('#token');
  await enterToken(lp2, LIVE_TOKEN);
  await lp2.waitForSelector('.zone.active', { timeout: 15000 });
  await lp2.click('.tabs-nav button:nth-child(2)');
  await lp2.waitForSelector('.spark');
  await lp2.fill('.filter-row input[type=search]', 'T-0008');
  await lp2.waitForTimeout(300);
  await lp2.locator('.task-row').filter({ hasText: 'T-0008' }).first().click();
  await lp2.waitForSelector('.tdetail');
  await shot(lp2, '12-live-T-0008-detail-390');
  const phoneText = await lp2.locator('.tdetail').first().innerText();
  check('D3 live 390: the same real task is fully readable on the phone',
    phoneText.includes('Continuously oversee') && phoneText.includes('oversight report'),
    `phone panel renders ${phoneText.length} chars of real task text`);
  const overflow = await lp2.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('D3 live 390: no horizontal overflow with the panel open',
    overflow <= 0, `scrollWidth - clientWidth = ${overflow}px`);
  await livePhone.close();

  // ------------------------------------------------- the live board is UNTOUCHED
  await browser.close();

  check('zero console errors across every phase',
    report.console_errors.length === 0,
    report.console_errors.length ? JSON.stringify(report.console_errors) : 'clean');

  report.finished_at = new Date().toISOString();
  report.sandbox = SANDBOX;
  report.verdict = report.checks.every((c) => c.pass) ? 'PASS' : 'FAIL';
  fs.writeFileSync(path.join(OUT, 'walk-0143-report.json'), JSON.stringify(report, null, 2));
  console.log(`\nVERDICT: ${report.verdict}  (${report.checks.filter((c) => c.pass).length}/${report.checks.length} checks, ${report.shots.length} shots)`);
})().catch((e) => { console.error('WALK FAILED:', e); process.exit(1); });

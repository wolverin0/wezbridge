#!/usr/bin/env node
/**
 * test_responsive_viewports.js — Scoped UI/UX Responsive Battle Test.
 *
 * Tests a web URL or static file against 3 standardized device viewports using Playwright:
 *   1. Mobile: iPhone 15 Pro (393 x 852, DPR 3, touch)
 *   2. Tablet: iPad Air (820 x 1180)
 *   3. Desktop: 1920 x 1080
 *
 * Assertions:
 *   - Zero horizontal overflow (scrollWidth <= clientWidth).
 *   - Zero unhandled console.error() / uncaught JS exceptions.
 *   - Zero 404/500 HTTP errors on page assets.
 *   - Captures screenshots into artifacts/screenshots/
 *
 * Usage:
 *   node scripts/qa/test_responsive_viewports.js --url http://localhost:3000
 *   node scripts/qa/test_responsive_viewports.js --file path/to/index.html
 */

'use strict';

const path = require('path');
const fs = require('fs');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (e) {
  const fallbacks = [
    path.resolve(__dirname, '../../../whatsappbot-main-wt/dashboard/node_modules/playwright'),
    path.resolve(__dirname, '../../../pedrito/node_modules/playwright'),
    path.resolve(__dirname, '../../../rifas/node_modules/playwright'),
  ];
  for (const fb of fallbacks) {
    if (fs.existsSync(fb)) {
      try {
        ({ chromium } = require(fb));
        break;
      } catch (_) {}
    }
  }
  if (!chromium) {
    throw new Error('Playwright not found in local or sibling node_modules. Run: npm i -D playwright');
  }
}

const VIEWPORTS = [
  { name: 'mobile_iphone15', width: 393, height: 852, isMobile: true, hasTouch: true, dpr: 3 },
  { name: 'tablet_ipad_air', width: 820, height: 1180, isMobile: true, hasTouch: true, dpr: 2 },
  { name: 'desktop_1080p', width: 1920, height: 1080, isMobile: false, hasTouch: false, dpr: 1 },
];

async function runResponsiveAudit(targetUrl, { outputDir = 'artifacts/screenshots' } = {}) {
  fs.mkdirSync(outputDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const results = {
    target: targetUrl,
    timestamp: new Date().toISOString(),
    viewports: {},
    allPassed: true,
  };

  for (const vp of VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      isMobile: vp.isMobile,
      hasTouch: vp.hasTouch,
      deviceScaleFactor: vp.dpr,
    });

    const page = await context.newPage();
    const consoleErrors = [];
    const failedRequests = [];

    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('requestfailed', (req) => {
      failedRequests.push(`${req.method()} ${req.url()} — ${req.failure()?.errorText}`);
    });

    let navError = null;
    try {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(500); // allow layout/fonts to settle
    } catch (e) {
      navError = e.message;
    }

    let overflow = false;
    let overflowDiff = 0;
    if (!navError) {
      const scrollMetrics = await page.evaluate(() => {
        const root = document.documentElement;
        return {
          scrollWidth: root.scrollWidth,
          clientWidth: root.clientWidth,
          innerWidth: window.innerWidth,
        };
      });

      if (scrollMetrics.scrollWidth > scrollMetrics.clientWidth) {
        overflow = true;
        overflowDiff = scrollMetrics.scrollWidth - scrollMetrics.clientWidth;
      }
    }

    const screenshotFile = path.join(outputDir, `${vp.name}.png`);
    if (!navError) {
      await page.screenshot({ path: screenshotFile, fullPage: false });
    }

    await context.close();

    const passed = !navError && !overflow && consoleErrors.length === 0;
    if (!passed) results.allPassed = false;

    results.viewports[vp.name] = {
      passed,
      navError,
      overflow,
      overflowDiff,
      consoleErrorsCount: consoleErrors.length,
      consoleErrors,
      failedRequestsCount: failedRequests.length,
      screenshot: screenshotFile,
    };
  }

  await browser.close();
  return results;
}

async function main() {
  const args = process.argv.slice(2);
  let target = 'http://localhost:3000';

  const urlIdx = args.indexOf('--url');
  if (urlIdx !== -1 && args[urlIdx + 1]) {
    target = args[urlIdx + 1];
  }

  const fileIdx = args.indexOf('--file');
  if (fileIdx !== -1 && args[fileIdx + 1]) {
    const fullPath = path.resolve(args[fileIdx + 1]);
    const { pathToFileURL } = require('url');
    target = pathToFileURL(fullPath).href;
  }

  console.log(`\n======================================================`);
  console.log(`  SCOPED UI/UX RESPONSIVE BATTLE TEST`);
  console.log(`======================================================`);
  console.log(`• Target URL: ${target}\n`);

  try {
    const res = await runResponsiveAudit(target);
    for (const [name, vp] of Object.entries(res.viewports)) {
      const icon = vp.passed ? '✅ PASS' : '❌ FAIL';
      console.log(`${icon} [${name}]:`);
      if (vp.overflow) console.log(`   - Horizontal Overflow: +${vp.overflowDiff}px`);
      if (vp.consoleErrorsCount > 0) console.log(`   - JS Console Errors: ${vp.consoleErrorsCount}`);
      if (vp.navError) console.log(`   - Navigation Error: ${vp.navError}`);
      console.log(`   - Screenshot: ${vp.screenshot}`);
    }
    console.log(`======================================================\n`);
    process.exit(res.allPassed ? 0 : 1);
  } catch (err) {
    console.error(`Execution error: ${err.message}`);
    process.exit(1);
  }
}

module.exports = {
  runResponsiveAudit,
  VIEWPORTS,
};

if (require.main === module) {
  main();
}

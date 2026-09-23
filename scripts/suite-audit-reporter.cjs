'use strict';
const path = require('node:path');
const {recordRun} = require('../src/decision-relay-report.cjs');

// Consume Node's structured aggregate, not prose or a hand-maintained baseline.
module.exports = async function* suiteAudit(events) {
  let summary;
  for await (const event of events) {
    if (event.type === 'test:summary' && !event.data.file) summary = event.data;
  }
  const counts = summary?.counts;
  const valid = counts && ['tests','passed','failed','cancelled','skipped']
    .every(key => Number.isInteger(counts[key]) && counts[key] >= 0);
  const failed = !valid || !summary.success || counts.failed > 0 || counts.cancelled > 0 || counts.tests === 0;
  const intel = process.env.WEZBRIDGE_INTEL_DIR || path.resolve(__dirname,'../../_intel');
  recordRun(intel,{counts:counts || null,reason:valid ? 'full-suite-zero-fail contract' : 'missing structured summary'},
    failed ? 1 : 0,{routine:'suite',cadenceHours:168});
  yield `suite-audit: ${failed ? 'RED' : 'GREEN'} ${JSON.stringify(counts || {})}\n`;
  if (failed) process.exitCode = 1;
};

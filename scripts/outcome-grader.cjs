#!/usr/bin/env node
'use strict';
/**
 * outcome-grader.cjs — Asynchronous rubric-graded verifier for pane work
 * (Task #3 from docs/PLAN-managed-agents-backfill.md).
 *
 * Local backfill of Anthropic Managed Agents' "Outcomes" feature
 * (mm-3627): given a rubric + the executor pane's recent output + an
 * optional git diff, grade the work in a SEPARATE context window. The
 * grader's verdict (satisfied | needs_revision | max_iterations_reached
 * | failed) drives orchestrator decisions instead of post-hoc spot
 * checks (mm-c407).
 *
 * Library API:
 *   buildPrompt({ work, rubric, taskDesc }) → string  (pure)
 *   parseGraderJson(stdout)               → grade obj (pure)
 *   grade(opts)                           → async invoke
 *
 * Backends (opts.backend or env WEZBRIDGE_GRADER_BACKEND):
 *   'stub'  (default) — returns satisfied; use for wiring + tests
 *   'claude'          — runs `claude -p --output-format json --permission-mode plan`
 *   'codex'           — runs `codex exec` against a prompt file
 *
 * Real-backend invocation is delegated to spawnSync — the orchestration
 * logic is testable without a live model.
 *
 * Output shape (matches Managed Agents' result enum):
 *   {
 *     result: 'satisfied' | 'needs_revision' | 'failed',
 *     explanation: string,
 *     gaps?: string[],         // criteria not yet met
 *     met?:  string[],         // criteria satisfied
 *     raw?:  string,           // backend stdout (for debug)
 *   }
 */

const { spawnSync } = require('node:child_process');

const RESULT_VALUES = ['satisfied', 'needs_revision', 'max_iterations_reached', 'failed'];

/**
 * Compose the grader prompt. Returns a single string suitable for any
 * stdin-fed LLM CLI. Designed to elicit STRICT JSON output.
 */
function buildPrompt({ work = '', rubric = '', taskDesc = '' }) {
  const sections = [];
  sections.push(
    'You are a strict, independent grader. Evaluate the WORK ARTIFACT below against the RUBRIC and return ONLY JSON, no prose.',
  );
  if (taskDesc) sections.push(`TASK DESCRIPTION:\n${taskDesc}`);
  sections.push(`RUBRIC:\n${rubric || '(no rubric supplied — fall back to "is the work complete and consistent with the task?")'}`);
  sections.push(`WORK ARTIFACT (pane tail / diff):\n${work || '(empty)'}`);
  sections.push(
    'Return JSON exactly matching this shape (no extra fields, no markdown fences):',
  );
  sections.push(JSON.stringify({
    result: 'satisfied | needs_revision | failed',
    explanation: 'one-paragraph summary of why',
    met: ['list of rubric criteria fully satisfied'],
    gaps: ['list of rubric criteria NOT satisfied with specifics'],
  }, null, 2));
  return sections.join('\n\n---\n\n');
}

/**
 * Pull a JSON object out of arbitrary stdout (LLMs sometimes wrap in
 * fences or add prose). Returns the normalized grade object.
 */
function parseGraderJson(stdout) {
  if (!stdout || typeof stdout !== 'string') {
    return { result: 'failed', explanation: 'empty grader output', raw: '' };
  }
  let json = null;
  // First try: whole stdout is JSON
  try { json = JSON.parse(stdout); } catch { /* try fence-strip */ }
  if (!json) {
    // Strip ```json ... ``` fence
    const fenced = stdout.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) {
      try { json = JSON.parse(fenced[1]); } catch { /* try first {...} block */ }
    }
  }
  if (!json) {
    const first = stdout.match(/\{[\s\S]*\}/);
    if (first) {
      try { json = JSON.parse(first[0]); } catch { /* give up */ }
    }
  }
  if (!json) {
    return { result: 'failed', explanation: 'grader output not parseable as JSON', raw: stdout.slice(0, 500) };
  }
  const result = RESULT_VALUES.includes(json.result) ? json.result : 'failed';
  return {
    result,
    explanation: typeof json.explanation === 'string' ? json.explanation : '',
    met: Array.isArray(json.met) ? json.met : [],
    gaps: Array.isArray(json.gaps) ? json.gaps : [],
    raw: stdout.slice(0, 2000),
  };
}

function _backend() {
  return process.env.WEZBRIDGE_GRADER_BACKEND || 'stub';
}

function _runStub() {
  return {
    result: 'satisfied',
    explanation: 'stub grader: no real model invoked. Set WEZBRIDGE_GRADER_BACKEND=claude (or codex) to run a real evaluation.',
    met: [],
    gaps: [],
    raw: '(stub)',
  };
}

function _runClaude(prompt, opts = {}) {
  const args = ['-p', '--output-format', 'json', '--permission-mode', 'plan'];
  if (opts.model) args.push('--model', opts.model);
  const r = spawnSync('claude', args, {
    input: prompt,
    encoding: 'utf8',
    timeout: opts.timeoutMs || 180_000,
    windowsHide: true,
  });
  if (r.error || (r.status !== 0 && !r.stdout)) {
    return {
      result: 'failed',
      explanation: `claude backend invocation failed: ${r.error?.message || 'exit ' + r.status}`,
      raw: (r.stderr || '').slice(0, 500),
    };
  }
  return parseGraderJson(r.stdout);
}

function _runCodex(prompt, opts = {}) {
  // codex exec takes the prompt via stdin and emits JSON-ish output
  const r = spawnSync('codex', ['exec', '--json'], {
    input: prompt,
    encoding: 'utf8',
    timeout: opts.timeoutMs || 180_000,
    windowsHide: true,
  });
  if (r.error || (r.status !== 0 && !r.stdout)) {
    return {
      result: 'failed',
      explanation: `codex backend invocation failed: ${r.error?.message || 'exit ' + r.status}`,
      raw: (r.stderr || '').slice(0, 500),
    };
  }
  return parseGraderJson(r.stdout);
}

/**
 * Grade a piece of work. Returns the grade object directly (synchronous
 * spawn under the hood). Backend selection is via opts.backend or
 * WEZBRIDGE_GRADER_BACKEND env (default 'stub').
 *
 * @param {Object} opts
 * @param {string} opts.work
 * @param {string} [opts.rubric]
 * @param {string} [opts.taskDesc]
 * @param {string} [opts.backend]   — 'stub'|'claude'|'codex'
 * @param {string} [opts.model]     — model override for backend
 * @param {number} [opts.timeoutMs]
 */
function grade(opts = {}) {
  const prompt = buildPrompt(opts);
  const backend = opts.backend || _backend();
  switch (backend) {
    case 'stub':   return _runStub(prompt);
    case 'claude': return _runClaude(prompt, opts);
    case 'codex':  return _runCodex(prompt, opts);
    default:
      return {
        result: 'failed',
        explanation: `unknown grader backend: ${backend}`,
        raw: '',
      };
  }
}

if (require.main === module) {
  // Tiny CLI: read prompt sources from stdin or files, write grade to stdout.
  // Usage: node scripts/outcome-grader.cjs --rubric <path> --work <path>
  const argv = process.argv.slice(2);
  function getArg(name) {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : null;
  }
  const fs = require('node:fs');
  const rubricPath = getArg('--rubric');
  const workPath = getArg('--work');
  const taskPath = getArg('--task');
  const rubric = rubricPath ? fs.readFileSync(rubricPath, 'utf8') : '';
  const work = workPath ? fs.readFileSync(workPath, 'utf8') : '';
  const taskDesc = taskPath ? fs.readFileSync(taskPath, 'utf8') : '';
  const out = grade({ rubric, work, taskDesc });
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  process.exit(out.result === 'satisfied' ? 0 : 1);
}

module.exports = {
  RESULT_VALUES,
  buildPrompt,
  parseGraderJson,
  grade,
};

'use strict';
/**
 * validate-model-tiers.cjs — schema/consistency validator for _intel/model-tiers.json.
 *
 * The tiers file is the single source that hooks, the ledger and briefs read to
 * decide which model+effort to route a task to. A silent typo there (unknown
 * model id, an effort not in that model's accepted list, a class pointing at a
 * nonexistent tier, an open degrade-map edge) would misroute the whole fleet.
 * This script is that guard: it loads the JSON, checks structure, and exits
 * non-zero with a specific message on the first violation it finds.
 *
 * Usage:
 *   node scripts/validate-model-tiers.cjs [path/to/model-tiers.json]
 *   node scripts/validate-model-tiers.cjs --print-matrix [path]
 *
 * Default path: ../.. /_intel/model-tiers.json relative to this repo (wezbridge
 * lives inside the "Py Apps" multi-project root; _intel/ is a sibling dir).
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_PATH = path.join(__dirname, '..', '..', '_intel', 'model-tiers.json');

class ModelTiersError extends Error {}

function loadModelTiers(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new ModelTiersError(`cannot read model-tiers file at ${filePath}: ${err.message}`);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new ModelTiersError(`invalid JSON in ${filePath}: ${err.message}`);
  }
  return data;
}

/**
 * Validate the structure of a parsed model-tiers document.
 * Throws ModelTiersError with a specific, actionable message on the first
 * violation found. Returns true on success.
 */
function validateModelTiers(data) {
  if (!data || typeof data !== 'object') {
    throw new ModelTiersError('root must be an object');
  }
  const { models, tiers, classes, degrade_on_rate_limit: degrade } = data;

  if (!models || typeof models !== 'object' || Array.isArray(models)) {
    throw new ModelTiersError('missing or invalid "models" object');
  }
  if (!tiers || typeof tiers !== 'object' || Array.isArray(tiers)) {
    throw new ModelTiersError('missing or invalid "tiers" object');
  }
  if (!classes || typeof classes !== 'object' || Array.isArray(classes)) {
    throw new ModelTiersError('missing or invalid "classes" object');
  }
  if (!degrade || typeof degrade !== 'object' || Array.isArray(degrade)) {
    throw new ModelTiersError('missing or invalid "degrade_on_rate_limit" object');
  }

  // Reject any lingering reference to the nonexistent gpt-6-terra model,
  // anywhere in the document (models keys/aliases, tier entries, raw text).
  const serialized = JSON.stringify(data);
  if (/gpt-6-terra/i.test(serialized)) {
    throw new ModelTiersError('found reference to "gpt-6-terra", which does not exist (GPT-6 family is Astra/Sol/Luna only)');
  }

  // Validate each model entry has a sane efforts list.
  for (const [modelId, model] of Object.entries(models)) {
    if (!model || typeof model !== 'object') {
      throw new ModelTiersError(`model "${modelId}" must be an object`);
    }
    if (!Array.isArray(model.efforts)) {
      throw new ModelTiersError(`model "${modelId}" is missing an "efforts" array`);
    }
    if (model.default_effort !== null && model.default_effort !== undefined) {
      if (!model.efforts.includes(model.default_effort)) {
        throw new ModelTiersError(
          `model "${modelId}" default_effort "${model.default_effort}" is not in its own efforts list [${model.efforts.join(', ')}]`
        );
      }
    } else if (model.efforts.length > 0) {
      throw new ModelTiersError(
        `model "${modelId}" has a null/missing default_effort but a non-empty efforts list — set a default or empty the list`
      );
    }
  }

  // Validate each tier's claude/codex entries reference real models with
  // efforts each model actually accepts (or null when the model has none).
  function validateTierEngine(tierId, engineName, engine) {
    if (engine === null || engine === undefined) return; // e.g. T5.codex, ORCH.codex
    if (typeof engine !== 'object') {
      throw new ModelTiersError(`tier "${tierId}".${engineName} must be an object or null`);
    }
    const { model: modelId, effort } = engine;
    if (!modelId || typeof modelId !== 'string') {
      throw new ModelTiersError(`tier "${tierId}".${engineName} is missing a "model" string`);
    }
    const model = models[modelId];
    if (!model) {
      throw new ModelTiersError(`tier "${tierId}".${engineName} references unknown model "${modelId}"`);
    }
    if (effort === null || effort === undefined) {
      if (model.efforts.length > 0) {
        throw new ModelTiersError(
          `tier "${tierId}".${engineName} uses null effort but model "${modelId}" accepts efforts [${model.efforts.join(', ')}]`
        );
      }
    } else if (!model.efforts.includes(effort)) {
      throw new ModelTiersError(
        `tier "${tierId}".${engineName} effort "${effort}" is not accepted by model "${modelId}" (accepted: [${model.efforts.join(', ')}])`
      );
    }
  }

  for (const [tierId, tier] of Object.entries(tiers)) {
    if (!tier || typeof tier !== 'object') {
      throw new ModelTiersError(`tier "${tierId}" must be an object`);
    }
    validateTierEngine(tierId, 'claude', tier.claude);
    validateTierEngine(tierId, 'codex', tier.codex);
  }

  // Validate classes map to existing tiers.
  for (const [classId, tierId] of Object.entries(classes)) {
    if (!tiers[tierId]) {
      throw new ModelTiersError(`class "${classId}" maps to unknown tier "${tierId}"`);
    }
  }

  // Validate degrade map is closed: every key and every value must be a real
  // tier id (a self-mapping, e.g. T1 -> T1, is the documented floor).
  for (const [fromTier, toTier] of Object.entries(degrade)) {
    if (!tiers[fromTier]) {
      throw new ModelTiersError(`degrade_on_rate_limit key "${fromTier}" is not a known tier`);
    }
    if (!tiers[toTier]) {
      throw new ModelTiersError(`degrade_on_rate_limit["${fromTier}"] targets unknown tier "${toTier}"`);
    }
  }

  return true;
}

function printMatrix(data) {
  const { classes, tiers } = data;
  const rows = [['class', 'tier', 'claude model', 'claude effort', 'codex model', 'codex effort']];
  for (const [classId, tierId] of Object.entries(classes)) {
    const tier = tiers[tierId] || {};
    const c = tier.claude || {};
    const x = tier.codex || {};
    rows.push([
      classId,
      tierId,
      c.model || '-',
      c.effort === null || c.effort === undefined ? '-' : c.effort,
      x ? (x.model || '-') : '-',
      x && x.effort !== undefined && x.effort !== null ? x.effort : (x ? '-' : '-'),
    ]);
  }
  const widths = rows[0].map((_, col) => Math.max(...rows.map((r) => String(r[col]).length)));
  for (const row of rows) {
    console.log(row.map((cell, i) => String(cell).padEnd(widths[i])).join('  '));
  }
}

function main() {
  const args = process.argv.slice(2);
  const printMatrixFlag = args.includes('--print-matrix');
  const positional = args.filter((a) => a !== '--print-matrix');
  const filePath = positional[0] ? path.resolve(positional[0]) : DEFAULT_PATH;

  let data;
  try {
    data = loadModelTiers(filePath);
    validateModelTiers(data);
  } catch (err) {
    if (err instanceof ModelTiersError) {
      console.error(`model-tiers validation FAILED: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  console.log(`model-tiers validation OK: ${filePath}`);
  console.log(`  ${Object.keys(data.models).length} models, ${Object.keys(data.tiers).length} tiers, ${Object.keys(data.classes).length} classes`);

  if (printMatrixFlag) {
    printMatrix(data);
  }
}

module.exports = { loadModelTiers, validateModelTiers, ModelTiersError, DEFAULT_PATH };

if (require.main === module) {
  main();
}

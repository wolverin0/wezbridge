#!/usr/bin/env node
/**
 * Memory Bridge: OpenClaw → MemoryKing
 *
 * Syncs OpenClaw's daily memory files into MemoryKing (the omnimemory).
 * MemoryKing stores in SQLite + Qdrant with OpenAI embeddings.
 *
 * Usage:
 *   node memory-bridge.cjs sync          # Full sync from OpenClaw
 *   node memory-bridge.cjs sync --recent # Only last 7 days
 *   node memory-bridge.cjs status        # Show sync status
 */

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ── Config (all from env vars) ──────────────────────────────────────────────

const SSH_HOST = process.env.OPENCLAW_SSH_HOST || '192.168.100.186';
const SSH_USER = process.env.OPENCLAW_SSH_USER || 'ggorbalan';
const MEMORY_PATH = process.env.OPENCLAW_MEMORY_PATH || '~/.openclaw/workspace/memory';
const MEMORYKING_URL = process.env.MEMORYKING_URL || 'http://192.168.100.155:37777';
const MEMORYKING_API_KEY = process.env.MEMORYKING_API_KEY || '';

// SSH key auth is preferred (no password needed if key is set up).
// Falls back to password only if OPENCLAW_SSH_PASS is set.
const SSH_PASS = process.env.OPENCLAW_SSH_PASS || '';

const REQUEST_TIMEOUT_MS = 10000;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

function mkHeaders() {
  const h = { 'Content-Type': 'application/json' };
  if (MEMORYKING_API_KEY) h['Authorization'] = `Bearer ${MEMORYKING_API_KEY}`;
  return h;
}

/**
 * Pre-redaction patterns applied BEFORE ingestion into any store.
 */
const REDACT_PATTERNS = [
  { name: 'openai_key',          rx: /\bsk-[A-Za-z0-9_\-]{12,}\b/g },
  { name: 'aws_access_key',      rx: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'private_key',         rx: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { name: 'jwt_token',           rx: /\beyJ[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]*/g },
  { name: 'github_token',        rx: /\b(?:ghp_[A-Za-z0-9]{36}|gho_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,})\b/g },
  { name: 'bearer_token',        rx: /Bearer\s+[A-Za-z0-9_\-\.]{8,}/gi },
  { name: 'password_assignment',  rx: /\b(?:password|passwd|pwd)\s*[:=]\s*([^\s,;`]+)/gi },
  { name: 'token_assignment',     rx: /\b(?:token|api[_-]?key|secret)\s*[:=]\s*([^\s,;`]+)/gi },
  { name: 'hex_token',           rx: /`([0-9a-f]{40,})`/g },
  { name: 'hex_token_ctx',       rx: /(?:token|key|secret|credential).{0,80}?([0-9a-f]{40,})/gi },
  { name: 'markdown_credential', rx: /\*\*(?:pass(?:word)?|pwd|secret|token|key|credential)s?\*\*\s*[:=]\s*`?([^\s`,;\n]+)/gi },
  { name: 'inline_credential',   rx: /(?:_?(?:api_?)?(?:token|key|secret|password|credential)s?_?)`?\s*[:=]\s*`([^`]+)`/gi },
  { name: 'connection_string',   rx: /(?:mongodb|postgres(?:ql)?|mysql|redis):\/\/[^:]+:[^@]+@/gi },
];

let redactStats = { total: 0, redacted: 0 };

function redactSecrets(text) {
  if (!text) return text;
  let out = text;
  let wasRedacted = false;
  for (const { name, rx } of REDACT_PATTERNS) {
    rx.lastIndex = 0;
    if (rx.test(out)) {
      rx.lastIndex = 0;
      out = out.replace(rx, `[REDACTED:${name}]`);
      wasRedacted = true;
    }
  }
  redactStats.total++;
  if (wasRedacted) redactStats.redacted++;
  return out;
}

// ── SSH (secure — uses execFileSync with args array) ────────────────────────

function sshExec(cmd) {
  try {
    const sshArgs = [
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ConnectTimeout=5',
      '-o', 'BatchMode=yes',
      `${SSH_USER}@${SSH_HOST}`,
      cmd,
    ];

    const result = execFileSync('ssh', sshArgs, {
      encoding: 'utf-8',
      timeout: 15000,
    });
    return result.trim();
  } catch (e) {
    console.error(`SSH error: ${e.message?.split('\n')[0]}`);
    return null;
  }
}

// ── MemoryKing HTTP client (with timeout + retry) ───────────────────────────

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function mkStore(content, memoryType, sourceAgent, entities) {
  const res = await fetchWithTimeout(`${MEMORYKING_URL}/store`, {
    method: 'POST',
    headers: mkHeaders(),
    body: JSON.stringify({
      content: content.substring(0, 4000),
      memory_type: memoryType || 'fact',
      confidence: 0.85,
      entities: entities || [],
    }),
  });
  if (!res.ok) {
    throw new Error(`MemoryKing ${res.status}`);
  }
  return res.json();
}

async function mkBatchStoreWithRetry(items, attempt = 1) {
  try {
    const res = await fetchWithTimeout(`${MEMORYKING_URL}/batch-store`, {
      method: 'POST',
      headers: mkHeaders(),
      body: JSON.stringify({ items }),
    });
    if (!res.ok) {
      throw new Error(`MemoryKing batch ${res.status}`);
    }
    return res.json();
  } catch (e) {
    if (attempt < MAX_RETRIES) {
      const delay = RETRY_DELAY_MS * attempt;
      console.error(`   Retry ${attempt}/${MAX_RETRIES} in ${delay}ms: ${e.message}`);
      await new Promise((r) => setTimeout(r, delay));
      return mkBatchStoreWithRetry(items, attempt + 1);
    }
    throw e;
  }
}

async function mkHealth() {
  try {
    const res = await fetchWithTimeout(`${MEMORYKING_URL}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

async function mkStats() {
  const res = await fetchWithTimeout(`${MEMORYKING_URL}/stats`);
  return res.json();
}

// ── Deduplication (content hash) ────────────────────────────────────────────

const DEDUP_FILE = path.join(__dirname, '.memory-bridge-hashes.json');

function loadSeenHashes() {
  try {
    return JSON.parse(fs.readFileSync(DEDUP_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function saveSeenHashes(hashes) {
  fs.writeFileSync(DEDUP_FILE, JSON.stringify(hashes));
}

function contentHash(text) {
  return crypto.createHash('md5').update(text).digest('hex');
}

// ── Parsers ─────────────────────────────────────────────────────────────────

function parseMemoryFile(content, filename) {
  const sections = [];
  const lines = content.split('\n');
  let currentSection = null;
  let currentBody = [];

  for (const line of lines) {
    if (line.startsWith('## ') || line.startsWith('### ')) {
      if (currentSection) {
        sections.push({
          heading: currentSection,
          body: currentBody.join('\n').trim(),
        });
      }
      currentSection = line.replace(/^#+\s*/, '');
      currentBody = [];
    } else if (currentSection) {
      currentBody.push(line);
    }
  }
  if (currentSection) {
    sections.push({
      heading: currentSection,
      body: currentBody.join('\n').trim(),
    });
  }

  return sections.map((s) => ({
    heading: s.heading,
    body: s.body,
    source: `openclaw:${filename}`,
  }));
}

function parseLearnings(content, filename) {
  const entries = [];
  const blocks = content.split(/^## /m).filter(Boolean);

  for (const block of blocks) {
    const lines = block.split('\n');
    const title = lines[0]?.trim() || '';
    const errorMatch = block.match(/\*\*Error:\*\*\s*(.+)/);
    const correctionMatch = block.match(/\*\*Corrección:\*\*\s*(.+)/);

    if (correctionMatch) {
      entries.push({
        claim: `Learning: ${correctionMatch[1]}`,
        context: errorMatch ? errorMatch[1].substring(0, 200) : title,
        source: `openclaw:learnings/${filename}`,
      });
    }
  }
  return entries;
}

// ── Sync ────────────────────────────────────────────────────────────────────

async function syncAll(recentOnly = false) {
  console.log('=== Memory Bridge: OpenClaw → MemoryKing ===\n');

  // 0. Check MemoryKing is reachable
  console.log(`0. Checking MemoryKing at ${MEMORYKING_URL}...`);
  const healthy = await mkHealth();
  if (!healthy) {
    console.error(`   MemoryKing not reachable at ${MEMORYKING_URL}`);
    console.error('   Start it with: memoryking-http (or python -m memoryking.server.http_server)');
    process.exit(1);
  }
  console.log('   Connected!\n');

  // Load dedup hashes
  const seenHashes = loadSeenHashes();
  let skippedDups = 0;

  // 1. List memory files
  console.log('1. Fetching file list from OpenClaw...');
  const findCmd = `find ${MEMORY_PATH} -name '*.md' -not -path '*/archive/*' | sort`;
  const fileList = sshExec(findCmd);
  if (!fileList) {
    console.error('Failed to connect to OpenClaw VM');
    process.exit(1);
  }

  const files = fileList.split('\n').filter(Boolean);
  console.log(`   Found ${files.length} memory files`);

  let targetFiles = files;
  if (recentOnly) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7);
    const cutoffStr = cutoff.toISOString().split('T')[0];
    targetFiles = files.filter((f) => {
      const dateMatch = f.match(/(\d{4}-\d{2}-\d{2})/);
      return dateMatch && dateMatch[1] >= cutoffStr;
    });
    console.log(`   Filtered to ${targetFiles.length} recent files (last 7 days)`);
  }

  // 2. Process files → batch queue
  const batchQueue = [];
  let errorCount = 0;

  for (const filepath of targetFiles) {
    const filename = path.basename(filepath, '.md');

    // Validate filename is actually .md
    if (!filepath.endsWith('.md')) {
      continue;
    }

    console.log(`\n   Processing: ${filename}`);

    const catCmd = `cat "${filepath}"`;
    const content = sshExec(catCmd);
    if (!content) {
      errorCount++;
      continue;
    }

    const isLearning = filepath.includes('/learnings/');

    if (isLearning) {
      const learnings = parseLearnings(content, filename);
      for (const entry of learnings) {
        const safeClaim = redactSecrets(entry.claim);
        const hash = contentHash(safeClaim);
        if (seenHashes[hash]) {
          skippedDups++;
          continue;
        }
        seenHashes[hash] = Date.now();
        batchQueue.push({
          content: safeClaim,
          memory_type: 'fact',
          confidence: 0.85,
          entities: [],
        });
      }
      console.log(`     -> ${learnings.length} learnings extracted`);
    } else {
      const sections = parseMemoryFile(content, filename);
      for (const section of sections) {
        const value = redactSecrets(`${section.heading}\n${section.body}`);
        const hash = contentHash(value);
        if (seenHashes[hash]) {
          skippedDups++;
          continue;
        }
        seenHashes[hash] = Date.now();
        batchQueue.push({
          content: value,
          memory_type: 'fact',
          confidence: 0.85,
          entities: [],
        });
      }
      console.log(`     -> ${sections.length} sections extracted`);
    }
  }

  // 3. Sync config files
  console.log('\n2. Syncing config files...');
  const configFiles = ['TOOLS.md', 'IDENTITY.md', 'MEMORY.md', 'USER.md'];
  for (const cfg of configFiles) {
    const catCmd = `cat ~/.openclaw/workspace/${cfg} 2>/dev/null`;
    const content = sshExec(catCmd);
    if (content) {
      const safeContent = redactSecrets(content.substring(0, 4000));
      const hash = contentHash(safeContent);
      if (!seenHashes[hash]) {
        seenHashes[hash] = Date.now();
        batchQueue.push({
          content: `OpenClaw config: ${cfg}\n${safeContent}`,
          memory_type: 'fact',
          confidence: 0.9,
          entities: ['openclaw'],
        });
      } else {
        skippedDups++;
      }
      console.log(`   OK ${cfg}`);
    }
  }

  // 4. Batch-store to MemoryKing (with retry)
  console.log(`\n3. Storing ${batchQueue.length} memories to MemoryKing (${skippedDups} duplicates skipped)...`);

  const CHUNK_SIZE = 50;
  let stored = 0;
  let errors = 0;

  for (let i = 0; i < batchQueue.length; i += CHUNK_SIZE) {
    const chunk = batchQueue.slice(i, i + CHUNK_SIZE);
    try {
      const result = await mkBatchStoreWithRetry(chunk);
      stored += result.stored || 0;
      errors += result.errors || 0;
      console.log(`   Chunk ${Math.floor(i / CHUNK_SIZE) + 1}: ${result.stored} stored, ${result.errors} errors`);
    } catch (e) {
      console.error(`   Chunk ${Math.floor(i / CHUNK_SIZE) + 1} failed after ${MAX_RETRIES} retries: ${e.message}`);
      errors += chunk.length;
    }
  }

  // 5. Save dedup hashes
  saveSeenHashes(seenHashes);

  console.log('\n=== Sync Complete ===');
  console.log(`   memories stored:    ${stored}`);
  console.log(`   duplicates skipped: ${skippedDups}`);
  console.log(`   errors:             ${errors}`);
  console.log(`   file errors:        ${errorCount}`);
  console.log(`   secrets redacted:   ${redactStats.redacted}/${redactStats.total} entries`);
}

async function showStatus() {
  console.log('=== Memory Bridge Status ===\n');

  // Check MemoryKing
  console.log(`MemoryKing (${MEMORYKING_URL}):`);
  const healthy = await mkHealth();
  if (healthy) {
    try {
      const stats = await mkStats();
      console.log(`  Total memories: ${stats.storage?.total_items || 'unknown'}`);
      console.log(`  By type:`, JSON.stringify(stats.storage?.by_type || {}));
      console.log(`  By state:`, JSON.stringify(stats.storage?.by_state || {}));
    } catch (e) {
      console.log(`  Connected but stats failed: ${e.message}`);
    }
  } else {
    console.log('  NOT reachable — start with: memoryking-http');
  }

  // Check OpenClaw connectivity
  const test = sshExec('echo "connected"');
  console.log(`\nOpenClaw VM: ${test === 'connected' ? 'reachable' : 'unreachable'}`);

  // Dedup stats
  try {
    const hashes = loadSeenHashes();
    console.log(`Dedup cache: ${Object.keys(hashes).length} entries`);
  } catch {
    console.log('Dedup cache: not initialized');
  }
}

// Main
const command = process.argv[2] || 'status';
const flags = process.argv.slice(3);

if (command === 'sync') {
  const recent = flags.includes('--recent');
  syncAll(recent).catch(console.error);
} else if (command === 'status') {
  showStatus().catch(console.error);
} else {
  console.log('Usage: node memory-bridge.cjs [sync|status] [--recent]');
}

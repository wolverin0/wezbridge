/**
 * Project Scanner — discovers Claude Code projects from ~/.claude/projects/.
 * Ported from claude-launcher.pyw's scanning logic to Node.js.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

// Cache decoded paths
const pathCache = new Map();

/**
 * Decode an encoded directory name by reading the cwd field from JSONL files.
 * E.g. "G---OneDrive-OneDrive-Desktop-Py-Apps-elbraserito" → "G:\_OneDrive\OneDrive\Desktop\Py Apps\elbraserito"
 */
function getRealPath(projectDir, encodedName) {
  if (pathCache.has(encodedName)) return pathCache.get(encodedName);

  try {
    const files = fs.readdirSync(projectDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(projectDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 3);

    for (const file of files) {
      const fullPath = path.join(projectDir, file.name);
      const content = readLastBytes(fullPath, 30000);
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
          const data = JSON.parse(line);
          if (data.cwd) {
            pathCache.set(encodedName, data.cwd);
            return data.cwd;
          }
        } catch { continue; }
      }
    }
  } catch { /* ignore */ }

  pathCache.set(encodedName, encodedName);
  return encodedName;
}

/**
 * Read the last N bytes of a file efficiently.
 */
function readLastBytes(filePath, bytes) {
  try {
    const stat = fs.statSync(filePath);
    const fd = fs.openSync(filePath, 'r');
    const start = Math.max(0, stat.size - bytes);
    const buf = Buffer.alloc(Math.min(bytes, stat.size));
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return buf.toString('utf-8');
  } catch {
    return '';
  }
}

/**
 * Encode a filesystem path the same way Claude Code does for ~/.claude/projects/ dir names.
 * Each special char (: \ / space _ -) maps to a single dash.
 */
function encodePathLikeClaude(p) {
  return p.replace(/[:\\/\s_-]/g, '-');
}

/**
 * Extract a human-readable project name by matching the encoded dir name
 * against the real decoded path. Walks up from the cwd to find which
 * directory level corresponds to the encoded project root.
 *
 * Example: encoded = "G---OneDrive-OneDrive-Desktop-Py-Apps-whatsappbot-prod---Copy---Copy-whatsappbot-final"
 *          cwd = "G:\_OneDrive\...\whatsappbot-final\dashboard\react-app"
 *          → matches at "whatsappbot-final", returns "whatsappbot-final"
 */
function extractProjectName(encodedName, decodedPath) {
  if (decodedPath && decodedPath !== encodedName) {
    const normalized = decodedPath.replace(/\\/g, '/');
    const parts = normalized.split('/').filter(Boolean);

    // Walk from full path down to 1 segment, check if encoding matches
    for (let i = parts.length; i >= 1; i--) {
      const candidate = parts.slice(0, i).join('/');
      if (encodePathLikeClaude(candidate) === encodedName) {
        return parts[i - 1]; // Last segment of the matched project root
      }
    }

    // Fallback: last segment of decoded path
    return parts[parts.length - 1] || encodedName;
  }

  // No decoded path available — return encoded name as-is
  return encodedName;
}

/**
 * Extract the full project root path by matching encoded name against decoded cwd.
 * Returns the path UP TO the project root (not deeper subfolders).
 */
function extractProjectRoot(encodedName, decodedPath) {
  if (decodedPath && decodedPath !== encodedName) {
    const normalized = decodedPath.replace(/\\/g, '/');
    const parts = normalized.split('/').filter(Boolean);

    for (let i = parts.length; i >= 1; i--) {
      const candidate = parts.slice(0, i).join('/');
      if (encodePathLikeClaude(candidate) === encodedName) {
        // Reconstruct the path with proper separators
        // On Windows, re-add the drive letter format
        const root = parts.slice(0, i).join('/');
        return root.match(/^[A-Z]:/) ? root : '/' + root;
      }
    }
  }
  return decodedPath || encodedName;
}

/**
 * Get session preview — last 6 conversation turns (90 chars each).
 * @param {string} sessionFile - Full path to JSONL file
 * @returns {Array<{role: string, text: string}>}
 */
function getSessionPreview(sessionFile) {
  const content = readLastBytes(sessionFile, 120000);
  const turns = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const d = JSON.parse(line);
      const dtype = d.type || '';
      if (['progress', 'file-history-snapshot', 'queue-operation'].includes(dtype)) continue;

      const msg = d.message || {};
      const role = msg.role || '';
      const contentField = msg.content || '';
      let text = '';
      const toolsUsed = [];

      if (Array.isArray(contentField)) {
        for (const block of contentField) {
          if (!block || typeof block !== 'object') continue;
          if (block.type === 'text' && block.text?.trim()) {
            text = block.text.trim();
          } else if (block.type === 'tool_use') {
            toolsUsed.push(friendlyTool(block.name || ''));
          }
        }
      } else if (typeof contentField === 'string') {
        text = contentField.trim();
      }

      if (text && text.startsWith('<system')) continue;
      if (text && text.startsWith('<teammate')) continue;
      if (text && text.startsWith('<local-command')) continue;
      if (text && text.startsWith('<command-name')) continue;
      if (text && text.startsWith('<hook')) continue;

      if (role === 'user' && text && text.length > 3) {
        turns.push({ role: 'user', text });
      } else if (role === 'assistant') {
        if (text) turns.push({ role: 'assistant', text });
        if (toolsUsed.length) turns.push({ role: 'tool', text: toolsUsed.join(', ') });
      }
    } catch { continue; }
  }

  // Merge consecutive tool entries
  const merged = [];
  for (const t of turns) {
    if (merged.length && merged[merged.length - 1].role === 'tool' && t.role === 'tool') {
      merged[merged.length - 1].text += ', ' + t.text;
    } else {
      merged.push(t);
    }
  }

  // Take last 6
  const result = [];
  for (let i = merged.length - 1; i >= 0 && result.length < 6; i--) {
    let text = merged[i].text.replace(/\n/g, ' ').trim().slice(0, 90);
    if (merged[i].text.length > 90) text += '...';
    result.push({ role: merged[i].role, text });
  }
  result.reverse();
  return result;
}

function friendlyTool(name) {
  const map = {
    Read: 'Read', Write: 'Write', Edit: 'Edit', Bash: 'Terminal',
    Glob: 'Search', Grep: 'Search', Task: 'Agent',
    WebFetch: 'Web', WebSearch: 'Web',
  };
  return map[name] || name;
}

/**
 * Get session cost from JSONL file.
 * @returns {{ costUsd: number, inputTokens: number, outputTokens: number }}
 */
function getSessionCost(sessionFile) {
  const result = { costUsd: 0, inputTokens: 0, outputTokens: 0 };
  // Read last 100KB to get recent assistant messages with usage data
  const content = readLastBytes(sessionFile, 100000);

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const d = JSON.parse(line);
      // Check for legacy summary type
      if (d.type === 'summary') {
        result.costUsd = d.costUSD || d.cost_usd || 0;
        result.inputTokens = d.inputTokens || d.input_tokens || 0;
        result.outputTokens = d.outputTokens || d.output_tokens || 0;
        return result;
      }
      // Parse actual Claude JSONL usage from assistant messages
      const u = d.message?.usage;
      if (u && d.type === 'assistant') {
        const inp = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
        const out = u.output_tokens || 0;
        result.inputTokens += inp;
        result.outputTokens += out;
      }
    } catch { continue; }
  }
  // Estimate cost: blended rate ~$6/M input, ~$30/M output
  result.costUsd = (result.inputTokens * 6 / 1e6) + (result.outputTokens * 30 / 1e6);
  return result;
}

/**
 * Get session health: 'clean', 'interrupted', or 'unknown'.
 */
function getSessionHealth(sessionFile) {
  const content = readLastBytes(sessionFile, 10000);
  let lastType = '';

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      lastType = JSON.parse(line).type || '';
    } catch { continue; }
  }

  if (['system', 'queue-operation'].includes(lastType)) return 'clean';
  if (['assistant', 'progress'].includes(lastType)) return 'interrupted';
  return 'unknown';
}

/**
 * Get files modified during a session from tool calls.
 */
function getSessionFiles(sessionFile) {
  const content = readLastBytes(sessionFile, 200000);
  const files = new Set();

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const d = JSON.parse(line);
      const msg = d.message || {};
      const contentField = msg.content;
      if (!Array.isArray(contentField)) continue;
      for (const block of contentField) {
        if (!block || typeof block !== 'object' || block.type !== 'tool_use') continue;
        const name = block.name || '';
        const inp = block.input || {};
        if (['Write', 'Edit', 'Read'].includes(name) && inp.file_path) {
          files.add(inp.file_path);
        } else if (name === 'NotebookEdit' && inp.notebook_path) {
          files.add(inp.notebook_path);
        }
      }
    } catch { continue; }
  }

  return [...files].sort();
}

/**
 * Export session as markdown.
 */
function exportSessionMarkdown(sessionFile) {
  const lines = [];
  try {
    const content = fs.readFileSync(sessionFile, 'utf-8');
    for (const raw of content.split('\n')) {
      if (!raw.trim()) continue;
      try {
        const d = JSON.parse(raw);
        const msg = d.message || {};
        const role = msg.role || '';
        const contentField = msg.content || '';
        let text = '';

        if (Array.isArray(contentField)) {
          for (const block of contentField) {
            if (block?.type === 'text' && block.text?.trim()) {
              text = block.text.trim();
            }
          }
        } else if (typeof contentField === 'string') {
          text = contentField.trim();
        }

        if (!text || text.startsWith('<system') || text.startsWith('<teammate')
            || text.startsWith('<local-command') || text.startsWith('<command-name')
            || text.startsWith('<hook')) continue;

        if (role === 'user' && text.length > 3) {
          lines.push(`\n## User\n\n${text}\n`);
        } else if (role === 'assistant' && text) {
          lines.push(`\n## Assistant\n\n${text}\n`);
        }
      } catch { continue; }
    }
  } catch { /* ignore */ }

  return lines.join('\n');
}

/**
 * Scan all sessions for a given project directory.
 * @param {string} projectDir - Full path to the encoded project dir
 * @returns {Array<{id: string, file: string, modified: Date, created: Date, size: number, duration: number, health: string}>}
 */
function scanSessions(projectDir) {
  const sessions = [];

  try {
    const files = fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl'));

    for (const f of files) {
      try {
        const fullPath = path.join(projectDir, f);
        const stat = fs.statSync(fullPath);
        const duration = Math.max(0, (stat.mtimeMs - stat.ctimeMs) / 1000);

        sessions.push({
          id: path.basename(f, '.jsonl'),
          file: fullPath,
          modified: new Date(stat.mtimeMs),
          created: new Date(stat.ctimeMs),
          size: stat.size,
          duration,
          health: getSessionHealth(fullPath),
        });
      } catch { continue; }
    }
  } catch { /* ignore */ }

  sessions.sort((a, b) => b.modified - a.modified);
  return sessions;
}

/**
 * Scan all Claude Code projects from ~/.claude/projects/.
 * @returns {Array<{name: string, path: string, encodedName: string, dir: string, sessionCount: number, lastActive: Date|null, health: string}>}
 */
function scanProjects() {
  if (!fs.existsSync(PROJECTS_DIR)) return [];

  const projects = [];

  try {
    const dirs = fs.readdirSync(PROJECTS_DIR);

    for (const d of dirs) {
      if (d === 'memory') continue;
      const dirPath = path.join(PROJECTS_DIR, d);
      try {
        if (!fs.statSync(dirPath).isDirectory()) continue;
      } catch { continue; }

      const decodedPath = getRealPath(dirPath, d);
      const sessions = scanSessions(dirPath);
      const name = extractProjectName(d, decodedPath);
      const projectRoot = extractProjectRoot(d, decodedPath);

      projects.push({
        name,
        path: decodedPath,
        projectRoot,
        encodedName: d,
        dir: dirPath,
        sessionCount: sessions.length,
        lastActive: sessions.length > 0 ? sessions[0].modified : null,
        health: sessions.length > 0 ? sessions[0].health : 'unknown',
      });
    }
  } catch { /* ignore */ }

  // Sort by last activity (most recent first)
  projects.sort((a, b) => {
    const aTime = a.lastActive ? a.lastActive.getTime() : 0;
    const bTime = b.lastActive ? b.lastActive.getTime() : 0;
    return bTime - aTime;
  });

  return projects;
}

/**
 * Get total costs across all sessions (for /costs command).
 * @param {string} [since] - 'today', 'week', or 'all'
 * @returns {{ totalUsd: number, totalInput: number, totalOutput: number, sessionCount: number }}
 */
function getCostSummary(since = 'all') {
  const result = { totalUsd: 0, totalInput: 0, totalOutput: 0, sessionCount: 0 };

  const now = new Date();
  let cutoff = null;
  if (since === 'today') {
    cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  } else if (since === 'week') {
    cutoff = new Date(now.getTime() - 7 * 86400000);
  }

  const projects = scanProjects();
  for (const proj of projects) {
    const sessions = scanSessions(proj.dir);
    for (const sess of sessions) {
      if (cutoff && sess.modified < cutoff) continue;
      const cost = getSessionCost(sess.file);
      result.totalUsd += cost.costUsd;
      result.totalInput += cost.inputTokens;
      result.totalOutput += cost.outputTokens;
      result.sessionCount++;
    }
  }

  return result;
}

/**
 * Format relative time from a Date.
 */
function relativeTime(date) {
  if (!date) return '';
  const diff = (Date.now() - date.getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return date.toLocaleDateString();
}

/**
 * Format duration in seconds to human-readable string.
 */
function formatDuration(seconds) {
  if (seconds < 60) return '<1m';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return m ? `${h}h${m}m` : `${h}h`;
}

module.exports = {
  scanProjects,
  scanSessions,
  getSessionPreview,
  getSessionCost,
  getSessionHealth,
  getSessionFiles,
  exportSessionMarkdown,
  getCostSummary,
  getRealPath,
  relativeTime,
  formatDuration,
  PROJECTS_DIR,
};

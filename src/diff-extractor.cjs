/**
 * Diff Extractor — git diff operations for WezBridge V2.
 * Extracts git diffs, staged changes, and recent commits from project directories.
 */
const { execFileSync } = require('child_process');
const path = require('path');

/**
 * Resolve the git root directory for a given project path.
 * Returns null if not a git repo.
 */
function getGitRoot(projectDir) {
  try {
    return execFileSync('git', ['-C', projectDir, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf-8',
      timeout: 5000,
      windowsHide: true,
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Get git diff stat summary: "3 files changed, +45 -12" + per-file breakdown.
 * @param {string} projectDir - Project directory path
 * @returns {{ summary: string, files: Array<{file: string, insertions: number, deletions: number}> } | null}
 */
function getGitDiffStat(projectDir) {
  const root = getGitRoot(projectDir);
  if (!root) return null;

  try {
    const stat = execFileSync('git', ['-C', root, 'diff', '--stat', '--stat-width=60'], {
      encoding: 'utf-8',
      timeout: 10000,
      windowsHide: true,
    }).trim();

    if (!stat) return null;

    const numstat = execFileSync('git', ['-C', root, 'diff', '--numstat'], {
      encoding: 'utf-8',
      timeout: 10000,
      windowsHide: true,
    }).trim();

    const files = numstat
      .split('\n')
      .filter(l => l.trim())
      .map(line => {
        const [ins, del, file] = line.split('\t');
        return {
          file: file || '',
          insertions: ins === '-' ? 0 : parseInt(ins, 10) || 0,
          deletions: del === '-' ? 0 : parseInt(del, 10) || 0,
        };
      });

    const totalIns = files.reduce((s, f) => s + f.insertions, 0);
    const totalDel = files.reduce((s, f) => s + f.deletions, 0);
    const summary = `${files.length} file${files.length !== 1 ? 's' : ''} changed, +${totalIns} -${totalDel}`;

    return { summary, files };
  } catch {
    return null;
  }
}

/**
 * Get unified diff, truncated to max characters.
 * @param {string} projectDir
 * @param {number} max - Max characters (default 8000)
 * @returns {string|null}
 */
function getGitDiff(projectDir, max = 8000) {
  const root = getGitRoot(projectDir);
  if (!root) return null;

  try {
    let diff = execFileSync('git', ['-C', root, 'diff'], {
      encoding: 'utf-8',
      timeout: 15000,
      windowsHide: true,
    });

    if (!diff.trim()) return null;

    if (diff.length > max) {
      // Truncate at file boundary (diff --git a/...)
      const truncated = diff.substring(0, max);
      const lastFile = truncated.lastIndexOf('\ndiff --git');
      if (lastFile > max * 0.3) {
        diff = truncated.substring(0, lastFile) + '\n\n[... truncated, use View Full Diff for complete output]';
      } else {
        diff = truncated + '\n\n[... truncated]';
      }
    }

    return diff;
  } catch {
    return null;
  }
}

/**
 * Get staged changes only.
 */
function getStagedDiff(projectDir) {
  const root = getGitRoot(projectDir);
  if (!root) return null;

  try {
    const diff = execFileSync('git', ['-C', root, 'diff', '--cached', '--stat', '--stat-width=60'], {
      encoding: 'utf-8',
      timeout: 10000,
      windowsHide: true,
    }).trim();
    return diff || null;
  } catch {
    return null;
  }
}

/**
 * Get last N commit messages.
 * @param {string} projectDir
 * @param {number} n
 * @returns {Array<{hash: string, message: string, date: string, author: string}>}
 */
function getRecentCommits(projectDir, n = 5) {
  const root = getGitRoot(projectDir);
  if (!root) return [];

  try {
    const log = execFileSync('git', [
      '-C', root, 'log',
      `--max-count=${n}`,
      '--format=%h|%s|%cr|%an',
    ], {
      encoding: 'utf-8',
      timeout: 10000,
      windowsHide: true,
    }).trim();

    if (!log) return [];

    return log.split('\n').map(line => {
      const [hash, message, date, author] = line.split('|');
      return { hash, message, date, author };
    });
  } catch {
    return [];
  }
}

/**
 * Format diff stat for Telegram HTML.
 * @param {{ summary: string, files: Array }} diffStat
 * @returns {string} HTML-formatted string
 */
function formatDiffForTelegram(diffStat) {
  if (!diffStat) return '';

  const escHtml = t => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const lines = [`<b>${escHtml(diffStat.summary)}</b>`];

  for (const f of diffStat.files.slice(0, 15)) {
    const shortName = f.file.length > 35
      ? '...' + f.file.slice(-32)
      : f.file;
    const bar = '+'.repeat(Math.min(f.insertions, 10)) + '-'.repeat(Math.min(f.deletions, 10));
    lines.push(`<code>${escHtml(shortName.padEnd(36))} | ${bar}</code>`);
  }

  if (diffStat.files.length > 15) {
    lines.push(`<i>... and ${diffStat.files.length - 15} more files</i>`);
  }

  return lines.join('\n');
}

/**
 * Format unified diff for Telegram HTML with +/- highlighting.
 * @param {string} diff - Raw unified diff
 * @returns {string}
 */
function formatUnifiedDiffForTelegram(diff) {
  if (!diff) return '';

  const escHtml = t => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const lines = diff.split('\n').map(line => {
    if (line.startsWith('+++') || line.startsWith('---')) {
      return `<b>${escHtml(line)}</b>`;
    }
    if (line.startsWith('+')) {
      return `<code>+ ${escHtml(line.slice(1))}</code>`;
    }
    if (line.startsWith('-')) {
      return `<code>- ${escHtml(line.slice(1))}</code>`;
    }
    if (line.startsWith('@@')) {
      return `<i>${escHtml(line)}</i>`;
    }
    return escHtml(line);
  });

  return lines.join('\n');
}

module.exports = {
  getGitRoot,
  getGitDiffStat,
  getGitDiff,
  getStagedDiff,
  getRecentCommits,
  formatDiffForTelegram,
  formatUnifiedDiffForTelegram,
};

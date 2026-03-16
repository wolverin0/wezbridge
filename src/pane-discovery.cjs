/**
 * Pane Discovery — scan WezTerm for existing Claude Code sessions.
 *
 * Detects which panes are running Claude Code by reading their terminal output
 * and matching known patterns (❯ prompt, permission dialogs, cost lines, etc.).
 * Extracts project path from the pane's working directory.
 *
 * This is the "eyes" for the omni Claude — it finds all your active sessions
 * across all your projects without you having to register them manually.
 */
const wez = require('./wezterm.cjs');

// Patterns that indicate a pane is running Claude Code
const CLAUDE_INDICATORS = [
  /❯/,                                   // Claude prompt character (anywhere)
  /\? \(y\/n\)/,                         // Permission prompt
  /\(Y\/n\)/i,                           // Permission variant
  /Total cost:/,                          // Cost summary
  /Do you want to proceed/i,             // Permission question
  /Allow .+\? \[y\/N\]/i,               // Allow prompt
  /❯\s*1\.\s*Yes/i,                     // Selection prompt
  /Press Enter to continue/,             // Continuation
  /claude\.ai\/code/i,                   // Session URL
  /Tokens used:/i,                       // Token counter
  /Claude Code/i,                        // Banner
  /\$ claude\b/,                         // Launch command visible
  /─.*claude.*─/i,                       // Status bar
  /bypass permissions/i,                  // Permission mode indicator
  /⏵⏵/,                                  // Claude status bar arrows
  /✻\s*(Cooked|Sautéed|Baked)/,          // Claude cooking metaphors (thinking time)
  /\(ctrl\+o to expand\)/,               // Claude collapsed output
  /⎿/,                                   // Claude agent output marker
  /●/,                                   // Claude action bullet
];

// Patterns for detecting session status (checked against LAST lines of output)
// Order matters: more specific patterns first, idle last (it's the fallback)
const STATUS_PATTERNS = {
  idle: [
    /❯.*$/m,                              // ❯ anywhere on a line (idle prompt, may have text/backslash after it)
    /[>]\s*$/m,                           // Generic > prompt
  ],
  permission: [
    /\? \(y\/n\)/,
    /\(Y\/n\)/i,
    /Do you want to proceed/i,
    /Allow .+\? \[y\/N\]/i,
    /❯\s*1\.\s*Yes/i,
    /approve or deny/i,
    /\[Yes\].*\[No\]/,
  ],
  continuation: [
    /Press Enter to continue/,
    /\? Enter .+ to continue/,
    /\(press enter\)/i,
  ],
  working: [
    /⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/,   // Spinner characters (Claude's working indicator)
    /\bThinking\.\.\./,              // Exact "Thinking..." (not just "thinking" in text)
    /\bReading\b.*\.\.\./,           // "Reading file..."
    /\bEditing\b.*\.\.\./,           // "Editing file..."
    /\bSearching\b.*\.\.\./,         // "Searching..."
    /\bWriting\b.*\.\.\./,           // "Writing file..."
    /\bRunning\b.*\.\.\./,           // "Running command..."
    /●.*agent/i,                      // Agent running indicator
  ],
};

/**
 * Scan all WezTerm panes and discover which ones are running Claude Code.
 *
 * @returns {Array<DiscoveredPane>} List of panes with Claude detection info
 *
 * @typedef {object} DiscoveredPane
 * @property {number} paneId - WezTerm pane ID
 * @property {boolean} isClaude - Whether this pane appears to be running Claude Code
 * @property {string} status - 'idle' | 'permission' | 'working' | 'continuation' | 'unknown'
 * @property {string|null} project - Detected project path (from cwd)
 * @property {string|null} projectName - Short project name (last dir component)
 * @property {string} title - Tab/pane title
 * @property {string} workspace - WezTerm workspace name
 * @property {string} lastLines - Last few lines of terminal output
 * @property {number} confidence - 0-100 confidence that this is a Claude session
 */
function discoverPanes() {
  const rawPanes = wez.listPanes();
  const discovered = [];

  for (const pane of rawPanes) {
    const paneId = parseInt(pane.pane_id || pane.paneid || pane.PANEID || '0', 10);
    const title = pane.title || pane.tab_title || '';
    const workspace = pane.workspace || 'default';
    const cwd = pane.cwd || null;

    let text = '';
    let lastLines = '';
    let confidence = 0;
    let status = 'unknown';

    try {
      text = wez.getFullText(paneId, 80);
      const lines = text.split('\n').filter(l => l.trim());
      lastLines = lines.slice(-20).join('\n');
    } catch {
      // Pane may be dead or inaccessible
      discovered.push({
        paneId, isClaude: false, status: 'error', project: null,
        projectName: null, title, workspace, lastLines: '', confidence: 0,
      });
      continue;
    }

    // Score confidence based on how many Claude indicators match
    let matchCount = 0;
    for (const pattern of CLAUDE_INDICATORS) {
      if (pattern.test(text)) matchCount++;
    }

    // 1 match = 30%, 2 = 60%, 3+ = 90%
    if (matchCount >= 3) confidence = 90;
    else if (matchCount === 2) confidence = 60;
    else if (matchCount === 1) confidence = 30;

    // Title hints boost confidence
    if (/claude/i.test(title)) confidence = Math.min(100, confidence + 20);

    // Detect status
    const checkPatterns = (patterns) => patterns.some(p => p.test(lastLines));
    if (checkPatterns(STATUS_PATTERNS.working)) status = 'working';
    else if (checkPatterns(STATUS_PATTERNS.permission)) status = 'permission';
    else if (checkPatterns(STATUS_PATTERNS.continuation)) status = 'continuation';
    else if (checkPatterns(STATUS_PATTERNS.idle)) status = 'idle';

    // Extract project path from cwd
    let project = null;
    let projectName = null;
    if (cwd) {
      // WezTerm returns file:// URIs on some platforms
      project = cwd.replace(/^file:\/\/[^/]*/, '').replace(/\/$/, '');
      // URL-decode
      try { project = decodeURIComponent(project); } catch {}
      const parts = project.split('/').filter(Boolean);
      projectName = parts[parts.length - 1] || null;
    }

    const isClaude = confidence >= 30;

    discovered.push({
      paneId, isClaude, status, project, projectName,
      title, workspace, lastLines, confidence,
    });
  }

  return discovered;
}

/**
 * Get only Claude Code panes, grouped by project.
 * @returns {Map<string, DiscoveredPane[]>} project path → panes
 */
function discoverByProject() {
  const panes = discoverPanes().filter(p => p.isClaude);
  const byProject = new Map();

  for (const pane of panes) {
    const key = pane.project || 'unknown';
    if (!byProject.has(key)) byProject.set(key, []);
    byProject.get(key).push(pane);
  }

  return byProject;
}

/**
 * Get a quick summary of all Claude sessions across projects.
 * @returns {object} { total, byStatus, projects }
 */
function getSummary() {
  const panes = discoverPanes().filter(p => p.isClaude);
  const byStatus = { idle: 0, working: 0, permission: 0, continuation: 0, unknown: 0 };
  const projects = new Map();

  for (const pane of panes) {
    byStatus[pane.status] = (byStatus[pane.status] || 0) + 1;
    const key = pane.projectName || pane.project || 'unknown';
    if (!projects.has(key)) projects.set(key, []);
    projects.get(key).push(pane);
  }

  return {
    total: panes.length,
    byStatus,
    projects: Object.fromEntries(projects),
  };
}

module.exports = {
  discoverPanes,
  discoverByProject,
  getSummary,
  CLAUDE_INDICATORS,
  STATUS_PATTERNS,
};

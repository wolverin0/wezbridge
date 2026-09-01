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
const { parseStatusBar } = require('./status-parser.cjs');

// Patterns that indicate a pane is running Claude Code
// Codex TUI markers — distinct from Claude Code's. A codex pane's title shows
// the model ("gpt-5.6-sol"), not the word "codex", so title-regex never caught
// it and codex panes were NEVER snapshotted (fixed 2026-07-15). These target
// codex's status bar: `gpt-5.6-sol high · <cwd> · Full Access · Ready ·
// Context 75% left · … · 0.144.4 · 258K window · Fast off`.
const CODEX_INDICATORS = [
  /\bgpt-[0-9]/i,                        // model name in the status bar
  /Full Access|Read Only|Ask for approval/, // codex approval modes (Claude has none)
  /Context \d+% left/i,                  // codex's "N% left / N% used" double format
  /window\b.*Fast o(n|ff)/i,            // status-bar tail "… window · Fast off"
  /usage limit reset available/i,        // codex usage banner
  /Run \/usage to use/i,                 // codex usage hint
];

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
    // Most reliable signal: Claude Code shows "esc to interrupt" ONLY during
    // active tool execution / thinking. Zero false positives in idle panes.
    /esc to interrupt/i,
    // Braille spinner characters (Claude's animated working indicator)
    /[\u280B\u2819\u2839\u2838\u283C\u2834\u2826\u2827\u2807\u280F]/,
    // Verb + ellipsis — modern Claude Code uses Unicode U+2026 (`…`), not
    // three literal dots. Broad catch-all for any capitalized
    // present-participle verb + ellipsis/dots:
    // Thinking… Reading… Writing… Editing… Searching… Running… Creating…
    // Analyzing… Implementing… Planning… Ingesting… Cooking… Brewing…
    // Computing… Sautéing… Sautéed… etc.
    /\b[A-Z][a-z\u00E0-\u00FF]{2,}(ing|ed)\s*(\u2026|\.{3})/,
    // Named verbs fallback (in case the catch-all misses; keeps pre-2026
    // patterns working)
    /\b(Thinking|Reading|Writing|Editing|Searching|Running|Creating|Analyzing|Implementing|Planning|Cooking|Brewing|Ingesting|Computing|Compiling|Deploying)\s*(\u2026|\.{3})/i,
    // Agent running indicator (● bullet preceding "agent" mention)
    /\u25CF.*agent/i,
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
 * @property {string} tabTitle - User-set WezTerm tab title
 * @property {string} workspace - WezTerm workspace name
 * @property {string} lastLines - Last few lines of terminal output
 * @property {number} confidence - 0-100 confidence that this is a Claude session
 * @property {string|null} persona - Detected persona name from tab title or system prompt file
 */
/**
 * T-0281: ¿el texto que devuelve get-text IDENTIFICA al proyecto que el censo le
 * atribuye a la pane? rc=0 a secas no distingue: 8 panes muertas con
 * "claude didn't exit cleanly" dan rc=0 sin ser de nadie (medido 2026-08-29).
 * Pura: recibe projectName (hoja del cwd) y el texto; devuelve {verified, verify}.
 */
const DEAD_PANE_RE = /didn.?t exit cleanly|no se cerr[oó] limpiamente/i;
function verifyPaneText({ projectName, text }) {
  const t = String(text || '');
  if (!t.trim()) return { verified: false, verify: 'empty-text' };
  if (DEAD_PANE_RE.test(t)) return { verified: false, verify: 'dead-pane-text' };
  if (!projectName) return { verified: false, verify: 'no-project' };
  // El nombre del proyecto aparece como segmento de path (cwd en la barra de
  // estado de Claude/Codex) o como palabra aislada: "wezbridge" no matchea
  // "wezbridge-old". Se compara en minusculas.
  const escaped = String(projectName).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[\\\\/\\s"'\`(\\[])${escaped}($|[\\\\/\\s"'\`)\\]:,])`, 'm');
  if (re.test(t.toLowerCase())) return { verified: true, verify: 'project-in-text' };
  return { verified: false, verify: 'text-mismatch' };
}

/**
 * Enumera los sockets vivos con sus panes. Con un wezterm.cjs que expone
 * listSockets() cada pane sale con SU socket; con uno viejo, la salida lo dice
 * (socket null) en vez de inventar uno. Nunca se llama listPanes() a secas
 * cuando hay enumeracion: un pane_id sin socket es justo el bug de T-0281.
 */
function enumerateSockets(wezOps) {
  if (typeof wezOps.listSockets === 'function') {
    const groups = wezOps.listSockets() || [];
    if (groups.length) return groups.map((g) => ({ socket: g.socket || null, panes: g.panes || [] }));
  }
  return [{ socket: null, panes: wezOps.listPanes() }];
}

function discoverPanes({ wez: wezOps = wez } = {}) {
  const discovered = [];
  const groups = enumerateSockets(wezOps);

  for (const group of groups) for (const pane of group.panes) {
    const socket = group.socket;
    const paneId = parseInt(pane.pane_id || pane.paneid || pane.PANEID || '0', 10);
    const title = pane.title || pane.tab_title || '';
    const tabTitle = pane.tab_title || '';
    const workspace = pane.workspace || 'default';
    const cwd = pane.cwd || null;

    let text = '';
    let lastLines = '';
    let confidence = 0;
    let status = 'unknown';

    try {
      text = wezOps.getFullText(paneId, 80, { socket });
      const lines = text.split('\n').filter(l => l.trim());
      lastLines = lines.slice(-20).join('\n');
    } catch {
      // Pane may be dead or inaccessible
      discovered.push({
        paneId, socket, verified: false, verify: 'get-text-failed',
        isClaude: false, isCodex: false, agent: null, status: 'error', project: null,
        projectName: null, title, tabTitle, workspace, lastLines: '', confidence: 0,
        persona: null, ctx: null, sessionPct: null, weeklyPct: null, model: null,
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

    // Codex detection — independent of the Claude score. 2+ markers required to
    // avoid false positives (goal/usage lines can appear in either tool).
    let codexMatch = 0;
    for (const pattern of CODEX_INDICATORS) if (pattern.test(text)) codexMatch++;
    if (/\bcodex\b/i.test(`${tabTitle} ${title}`)) codexMatch++;
    const isCodex = codexMatch >= 2;

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

    // Extract persona from tab_title (wezterm's user-set title) or title (process title).
    // setTabTitle sets tab_title, but title is the process name (e.g. "bash.exe").
    // Check both fields — tab_title is the primary source for persona markers.
    const combinedTitle = tabTitle + ' ' + title;
    const personaMatch = combinedTitle.match(/\[([a-zA-Z0-9._-]+)\]/);
    let persona = personaMatch ? personaMatch[1] : null;

    // Fallback: extract persona from --append-system-prompt-file in terminal output
    if (!persona) {
      const sysPromptMatch = lastLines.match(/--append-system-prompt-file\s+\S*[/\\]([a-zA-Z0-9._-]+)\.md/);
      if (sysPromptMatch) persona = sysPromptMatch[1];
    }

    // v2.6: parse status bar for Ctx% / Session% / Weekly% / model.
    // Uses the last 30 lines to capture the status bar if present.
    const statusLines = text.split('\n').slice(-30);
    const metrics = parseStatusBar(statusLines) || {};
    const ctx = typeof metrics.ctx === 'number' ? metrics.ctx : null;
    const sessionPct = typeof metrics.session === 'number' ? metrics.session : null;
    const weeklyPct = typeof metrics.weekly === 'number' ? metrics.weekly : null;
    const model = metrics.model || null;

    // agent: which CLI this pane runs. Codex wins if detected (a codex pane
    // never trips the ❯/bypass-permissions Claude markers, but be explicit).
    const agent = isCodex ? 'codex' : (isClaude ? 'claude' : null);

    // T-0281: el socket contra el que este pane_id es valido, y si el texto lo
    // identifica. Sin enumeracion de sockets no se afirma verificacion alguna.
    const verdict = socket === null
      ? { verified: false, verify: 'socket-unknown' }
      : verifyPaneText({ projectName, text });

    discovered.push({
      paneId, socket, verified: verdict.verified, verify: verdict.verify,
      isClaude, isCodex, agent, status, project, projectName,
      title, tabTitle, workspace, lastLines, confidence, rawText: text, persona,
      ctx, sessionPct, weeklyPct, model,
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
  verifyPaneText,
  enumerateSockets,
  discoverByProject,
  getSummary,
  CLAUDE_INDICATORS,
  STATUS_PATTERNS,
};

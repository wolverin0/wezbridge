/**
 * WezTerm CLI bridge — restores v2.7-style "control any WezTerm pane via MCP".
 *
 * v3 dropped WezTerm CLI integration in favor of in-process PtyManager. This
 * lost the ability to control panes the user opens manually in WezTerm
 * (i.e. tabs not spawned through theorchestra). This module re-adds that
 * surface as a graceful fallback: if `wezterm` is on PATH, theorchestra can
 * see + control all WezTerm panes; if not, theorchestra silently falls back
 * to PtyManager-only behavior (no-op for this bridge).
 *
 * ID-space distinction:
 *   - PtyManager IDs:  UUID v4   ("xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx")
 *   - WezTerm pane IDs: small integers ("0", "5", "12")
 * The two never collide, so a single `pane_id` field can route to either.
 *
 * Dispatch helper `isWeztermPaneId(id)` is the canonical splitter — every
 * MCP/HTTP route that handles a pane_id checks it before deciding which
 * surface (PtyManager HTTP or wezterm CLI exec) to call.
 */

import { spawnSync } from 'node:child_process';

let weztermAvailable: boolean | null = null;

export function isWeztermAvailable(): boolean {
  if (weztermAvailable !== null) return weztermAvailable;
  if (process.env.THEORCHESTRA_NO_WEZTERM_BRIDGE === '1') {
    weztermAvailable = false;
    return false;
  }
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    const r = spawnSync(cmd, ['wezterm'], { stdio: 'ignore' });
    weztermAvailable = r.status === 0;
  } catch {
    weztermAvailable = false;
  }
  if (weztermAvailable) {
    console.log('[wezterm-bridge] enabled (wezterm CLI on PATH)');
  } else {
    console.log('[wezterm-bridge] disabled (wezterm CLI not on PATH or opted out)');
  }
  return weztermAvailable;
}

/** A pane_id is wezterm-owned iff it's a positive integer. */
export function isWeztermPaneId(id: string): boolean {
  return /^\d+$/.test(id);
}

export interface WeztermPane {
  pane_id: string;
  window_id: number;
  tab_id: number;
  workspace: string;
  title: string;
  tab_title: string;
  cwd: string;
  rows: number;
  cols: number;
  is_active: boolean;
}

interface RawWeztermPane {
  pane_id: number;
  window_id: number;
  tab_id: number;
  workspace?: string;
  title?: string;
  tab_title?: string;
  cwd?: string;
  size?: { rows: number; cols: number };
  is_active?: boolean;
}

function normalizeCwd(cwdUri: string | undefined): string {
  if (!cwdUri) return '';
  // wezterm reports cwd as file:///path on POSIX, file:///G:/path on Windows
  let p = cwdUri.replace(/^file:\/\//, '');
  // Decode percent-encoded chars (spaces especially)
  try {
    p = decodeURIComponent(p);
  } catch {
    /* keep raw */
  }
  // On Windows the leading "/" before "G:" is spurious — strip if drive-letter follows
  if (process.platform === 'win32' && /^\/[a-zA-Z]:/.test(p)) {
    p = p.slice(1);
  }
  return p.replace(/\/$/, '');
}

export function listWeztermPanes(): WeztermPane[] {
  if (!isWeztermAvailable()) return [];
  try {
    const r = spawnSync('wezterm', ['cli', 'list', '--format', 'json'], {
      encoding: 'utf-8',
      timeout: 5_000,
    });
    if (r.status !== 0 || !r.stdout) return [];
    const arr = JSON.parse(r.stdout) as RawWeztermPane[];
    if (!Array.isArray(arr)) return [];
    return arr.map((p) => ({
      pane_id: String(p.pane_id),
      window_id: p.window_id,
      tab_id: p.tab_id,
      workspace: p.workspace ?? 'default',
      title: p.title ?? '',
      tab_title: p.tab_title ?? '',
      cwd: normalizeCwd(p.cwd),
      rows: p.size?.rows ?? 0,
      cols: p.size?.cols ?? 0,
      is_active: p.is_active === true,
    }));
  } catch {
    return [];
  }
}

export function getWeztermPaneText(paneId: string, lines = 100): string {
  if (!isWeztermAvailable()) return '';
  try {
    const r = spawnSync('wezterm', ['cli', 'get-text', '--pane-id', paneId], {
      encoding: 'utf-8',
      timeout: 5_000,
    });
    if (r.status !== 0 || !r.stdout) return '';
    if (lines <= 0) return r.stdout;
    const all = r.stdout.split(/\r?\n/);
    return all.slice(Math.max(0, all.length - lines)).join('\n');
  } catch {
    return '';
  }
}

export function sendTextToWeztermPane(paneId: string, text: string): boolean {
  if (!isWeztermAvailable()) return false;
  try {
    const r = spawnSync('wezterm', ['cli', 'send-text', '--pane-id', paneId, '--no-paste'], {
      input: text,
      timeout: 5_000,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

/**
 * Send a key alias (e.g. 'enter', 'ctrl+c', 'escape') to a WezTerm pane.
 * Reuses the same key→bytes table the PtyManager path uses, so behaviour is
 * consistent across both pane sources.
 */
export function sendKeyToWeztermPane(paneId: string, keyAlias: string): boolean {
  const bytes = keyAliasToWeztermBytes(keyAlias);
  return sendTextToWeztermPane(paneId, bytes);
}

function keyAliasToWeztermBytes(key: string): string {
  const k = key.toLowerCase().trim();
  switch (k) {
    case 'enter':
    case 'return':
      return '\r';
    case 'tab':
      return '\t';
    case 'escape':
    case 'esc':
      return '\x1b';
    case 'up':
      return '\x1b[A';
    case 'down':
      return '\x1b[B';
    case 'right':
      return '\x1b[C';
    case 'left':
      return '\x1b[D';
    case 'ctrl+c':
      return '\x03';
    case 'ctrl+d':
      return '\x04';
    case 'backspace':
      return '\x7f';
    default:
      // Single-char keys ("y", "n", "1") + raw bytes pass through.
      return key;
  }
}

/**
 * Translate a WezTerm pane into a SessionRecord-shaped object so the API
 * can return a single merged list to consumers.
 */
export function weztermPaneToSessionRecord(p: WeztermPane): {
  sessionId: string;
  cli: string;
  cwd: string;
  tabTitle: string;
  pid: number;
  spawnedAt: string;
  persona: null;
  permissionMode: null;
  spawnedByPaneId: null;
  source: 'wezterm-cli';
  windowId: number;
  tabId: number;
  workspace: string;
  isActive: boolean;
} {
  return {
    sessionId: p.pane_id,
    cli: 'wezterm-pane',
    cwd: p.cwd,
    tabTitle: p.tab_title || p.title || `pane-${p.pane_id}`,
    pid: -1, // wezterm CLI doesn't expose pid here; -1 marks "unknown via bridge"
    spawnedAt: new Date(0).toISOString(), // unknown — placeholder
    persona: null,
    permissionMode: null,
    spawnedByPaneId: null,
    source: 'wezterm-cli' as const,
    windowId: p.window_id,
    tabId: p.tab_id,
    workspace: p.workspace,
    isActive: p.is_active,
  };
}

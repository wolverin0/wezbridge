import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { getToken } from '../auth';

/**
 * XtermPane — embedded xterm.js per pane card.
 *
 * Subscribes to GET /api/sessions/:id/pty-stream (SSE). The backend emits
 * a 'replay' event with the full ring buffer first, then 'data' events per
 * PTY chunk. Browser writes each chunk straight into Terminal.write() —
 * no SGR parsing, no status-bar heuristics, no CR-collapse on our side.
 *
 * ResizeObserver propagates container resizes to the backend so the PTY +
 * the headless mirror stay in sync with the embedded terminal dimensions.
 * Without this, alt-screen apps (vim, htop) misrender on window resize.
 */

interface XtermPaneProps {
  sessionId: string;
  className?: string;
}

const DEFAULT_THEME = {
  background: '#0e1116',
  foreground: '#d0d4da',
  cursor: '#7cc4ff',
  cursorAccent: '#0e1116',
  selectionBackground: 'rgba(124, 196, 255, 0.30)',
  black: '#2e3440',
  red: '#e06c75',
  green: '#98c379',
  yellow: '#e5c07b',
  blue: '#61afef',
  magenta: '#c678dd',
  cyan: '#56b6c2',
  white: '#d0d4da',
  brightBlack: '#5c6370',
  brightRed: '#ff7b7b',
  brightGreen: '#a7e3a3',
  brightYellow: '#f2d27b',
  brightBlue: '#7cc4ff',
  brightMagenta: '#e491ee',
  brightCyan: '#66d9d0',
  brightWhite: '#ffffff',
};

export function XtermPane({ sessionId, className }: XtermPaneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      theme: DEFAULT_THEME,
      fontFamily: 'Cascadia Code, Consolas, Menlo, ui-monospace, monospace',
      fontSize: 13,
      lineHeight: 1.15,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: true,
      convertEol: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);

    let lastSentDims = { cols: 0, rows: 0 };
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;

    const postResize = (cols: number, rows: number): void => {
      if (cols === lastSentDims.cols && rows === lastSentDims.rows) return;
      lastSentDims = { cols, rows };
      const token = getToken();
      const url = token
        ? `/api/sessions/${encodeURIComponent(sessionId)}/resize?token=${encodeURIComponent(token)}`
        : `/api/sessions/${encodeURIComponent(sessionId)}/resize`;
      void fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cols, rows }),
      }).catch(() => {
        /* transient — next resize retries */
      });
    };

    const doFit = (): void => {
      try {
        fit.fit();
        postResize(term.cols, term.rows);
      } catch {
        /* container not visible / 0-sized — skip */
      }
    };

    // Initial fit after mount (next tick lets layout settle)
    const initialFit = setTimeout(doFit, 50);

    // Coalesce rapid container resizes
    const ro = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(doFit, 100);
    });
    ro.observe(container);

    // SSE subscription
    const token = getToken();
    const streamUrl = token
      ? `/api/sessions/${encodeURIComponent(sessionId)}/pty-stream?token=${encodeURIComponent(token)}`
      : `/api/sessions/${encodeURIComponent(sessionId)}/pty-stream`;
    const es = new EventSource(streamUrl);

    const onReplay = (msg: MessageEvent): void => {
      try {
        const chunk = JSON.parse(msg.data) as string;
        term.write(chunk);
      } catch {
        /* malformed frame */
      }
    };
    const onData = (msg: MessageEvent): void => {
      try {
        const chunk = JSON.parse(msg.data) as string;
        term.write(chunk);
      } catch {
        /* malformed frame */
      }
    };
    es.addEventListener('replay', onReplay as EventListener);
    es.addEventListener('data', onData as EventListener);

    return () => {
      clearTimeout(initialFit);
      if (resizeTimer) clearTimeout(resizeTimer);
      ro.disconnect();
      es.removeEventListener('replay', onReplay as EventListener);
      es.removeEventListener('data', onData as EventListener);
      es.close();
      try {
        term.dispose();
      } catch {
        /* already disposed */
      }
    };
  }, [sessionId]);

  return (
    <div
      ref={containerRef}
      className={className ?? 'xterm-pane'}
      style={{ width: '100%', height: '100%', background: DEFAULT_THEME.background }}
    />
  );
}

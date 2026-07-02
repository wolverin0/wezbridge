/**
 * Peers broker — push-channel transport for Claude↔Claude A2A.
 *
 * Lives inside the theorchestra backend process (no separate daemon). Two
 * surfaces:
 *
 *   1. Registry — a Claude pane registers its `pane_id` here when its
 *      wezbridge-peers channel plugin starts polling. Used by `peer_list`
 *      and by `auto_send` to decide push-vs-poll.
 *
 *   2. Inbox — `peer_send` writes a row; the receiver's plugin polls and
 *      pushes the body into the Claude session via the channel protocol.
 *
 * SQLite via better-sqlite3 at `vault/_peers/messages.db`. WAL mode so
 * concurrent readers + writer don't block. All queries parameterized.
 *
 * MCP-shaped tools (`peer_send`, `peer_list`, `set_summary`, `peer_check`,
 * `auto_send`) live in `src/mcp/handlers/peers.ts` and call into this
 * module. The HTTP surface (`/broker/*`) lives in `ws-server.ts` and is
 * what the channel plugin polls every ~1s.
 *
 * Hybrid model: push for Claude+registered peers, MCP polling fallback for
 * Codex/Gemini/bash via the existing send_prompt/send_key tools. Never
 * collapses to Claude-only — preserves the CLI-agnostic invariant.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import type { Database as DatabaseT } from 'better-sqlite3';

export interface PeerMessage {
  id: number;
  from_pane_id: string;
  to_pane_id: string;
  corr_id: string | null;
  body: string;
  sent_at: string;
  delivered_at: string | null;
}

export interface PeerRegistration {
  pane_id: string;
  registered_at: string;
  last_seen_at: string;
  summary: string | null;
}

export interface PeerSendResult {
  id: number;
  sent_at: string;
}

export class PeersBroker {
  private readonly db: DatabaseT;

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS peers (
        pane_id TEXT PRIMARY KEY,
        registered_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        summary TEXT
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_pane_id TEXT NOT NULL,
        to_pane_id TEXT NOT NULL,
        corr_id TEXT,
        body TEXT NOT NULL,
        sent_at TEXT NOT NULL,
        delivered_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_messages_inbox
        ON messages (to_pane_id, delivered_at);
    `);
  }

  /** Called by a Claude pane's channel plugin on startup + each poll. */
  register(pane_id: string): PeerRegistration {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO peers (pane_id, registered_at, last_seen_at, summary)
      VALUES (@pane_id, @now, @now, NULL)
      ON CONFLICT(pane_id) DO UPDATE SET last_seen_at = excluded.last_seen_at
    `);
    stmt.run({ pane_id, now });
    const row = this.db
      .prepare(`SELECT pane_id, registered_at, last_seen_at, summary FROM peers WHERE pane_id = ?`)
      .get(pane_id) as PeerRegistration;
    return row;
  }

  /** Returns true if pane_id has a recent registration (within staleness window). */
  isRegistered(pane_id: string, staleMs = 5 * 60_000): boolean {
    const row = this.db
      .prepare(`SELECT last_seen_at FROM peers WHERE pane_id = ?`)
      .get(pane_id) as { last_seen_at: string } | undefined;
    if (!row) return false;
    const age = Date.now() - Date.parse(row.last_seen_at);
    return Number.isFinite(age) && age < staleMs;
  }

  list(): PeerRegistration[] {
    return this.db
      .prepare(`SELECT pane_id, registered_at, last_seen_at, summary FROM peers ORDER BY last_seen_at DESC`)
      .all() as PeerRegistration[];
  }

  setSummary(pane_id: string, summary: string): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(`UPDATE peers SET summary = ?, last_seen_at = ? WHERE pane_id = ?`)
      .run(summary, now, pane_id);
    return result.changes > 0;
  }

  /** Insert a message into the receiver's inbox. */
  send(from_pane_id: string, to_pane_id: string, body: string, corr_id?: string): PeerSendResult {
    const sent_at = new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO messages (from_pane_id, to_pane_id, corr_id, body, sent_at, delivered_at)
         VALUES (?, ?, ?, ?, ?, NULL)`,
      )
      .run(from_pane_id, to_pane_id, corr_id ?? null, body, sent_at);
    return { id: result.lastInsertRowid as number, sent_at };
  }

  /**
   * Poll the inbox for `pane_id`. Atomically marks every returned message
   * as delivered_at = now() so the next poll only sees newer messages.
   * Plugin retries are idempotent: if the channel push fails after this
   * call, the message is still marked delivered — caller's responsibility
   * to retry at the channel layer (or accept the loss).
   */
  poll(pane_id: string): PeerMessage[] {
    const now = new Date().toISOString();
    const tx = this.db.transaction((target: string, ts: string): PeerMessage[] => {
      const rows = this.db
        .prepare(
          `SELECT id, from_pane_id, to_pane_id, corr_id, body, sent_at, delivered_at
           FROM messages WHERE to_pane_id = ? AND delivered_at IS NULL
           ORDER BY id ASC`,
        )
        .all(target) as PeerMessage[];
      if (rows.length > 0) {
        const ids = rows.map((r) => r.id);
        const placeholders = ids.map(() => '?').join(',');
        this.db
          .prepare(`UPDATE messages SET delivered_at = ? WHERE id IN (${placeholders})`)
          .run(ts, ...ids);
      }
      return rows;
    });
    return tx(pane_id, now);
  }

  /** Inspect (without consuming) — useful for /broker/inbox debug endpoints. */
  peek(pane_id: string, limit = 20): PeerMessage[] {
    return this.db
      .prepare(
        `SELECT id, from_pane_id, to_pane_id, corr_id, body, sent_at, delivered_at
         FROM messages WHERE to_pane_id = ?
         ORDER BY id DESC LIMIT ?`,
      )
      .all(pane_id, limit) as PeerMessage[];
  }

  unregister(pane_id: string): void {
    this.db.prepare(`DELETE FROM peers WHERE pane_id = ?`).run(pane_id);
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
  }
}

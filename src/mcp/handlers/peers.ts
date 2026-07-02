/**
 * Peers handlers — Pieza 2 hybrid A2A.
 *
 * Five MCP tools that talk to the embedded peers broker (`/broker/*` HTTP
 * surface, see `src/backend/peers-broker.ts`):
 *
 *   - peer_send      direct broker write; receiver picks up via peer_check
 *                    (or, once the wezbridge-peers channel plugin lands, via
 *                    instant push through the channel protocol)
 *   - peer_list      enumerate Claude panes that have registered with broker
 *   - peer_check     manual poll — useful before the channel plugin ships,
 *                    or as a fallback when the plugin isn't loaded
 *   - set_summary    advertise what the calling pane is doing (visible to
 *                    other panes via peer_list)
 *   - auto_send      hybrid resolver: if target is a registered Claude pane,
 *                    peer_send it; else fall back to send_prompt + send_key.
 *                    Preserves the CLI-agnostic invariant — Codex/Gemini/bash
 *                    keep working through the existing send_prompt path.
 *
 * The broker is opt-out via THEORCHESTRA_NO_PEERS=1; if disabled, every tool
 * here returns an explanatory error envelope.
 */

import { z } from 'zod';

import { backendClient } from '../client.js';
import {
  callBackend,
  errorResult,
  jsonResult,
  textResult,
  type ToolHandler,
  type ToolResult,
} from '../handler-types.js';

// ─── peer_send ─────────────────────────────────────────────────────────────

interface PeerSendArgs {
  target_pane_id: string;
  body: string;
  corr_id?: string;
}

const peerSendInput = {
  target_pane_id: z.string().describe('The session_id of the destination Claude pane.'),
  body: z.string().describe('The message body to deliver to the target pane.'),
  corr_id: z
    .string()
    .optional()
    .describe('Optional correlation ID for threading replies back to a prior request.'),
};

const peerSendHandler: ToolHandler<PeerSendArgs> = {
  name: 'peer_send',
  description:
    "Send a structured message to another pane via the peers broker. Direct write; receiver picks it up via the channel plugin (instant) or via peer_check (manual poll). Use this for Claude<->Claude when you want push semantics — for Codex/Gemini/bash use send_prompt instead, or auto_send to let the system choose.",
  inputSchema: peerSendInput,
  run: async ({ target_pane_id, body, corr_id }): Promise<ToolResult> => {
    // The "from" pane is whoever is calling the MCP server. We don't have a
    // first-class identity here yet — the MCP transport doesn't surface it —
    // so we let the caller embed it in the body or pass via env if needed.
    // Falls back to "mcp:unknown" for the v1 cut.
    const fromPaneId = process.env.THEORCHESTRA_PANE_ID ?? 'mcp:unknown';
    const call = await callBackend(`peer_send(${target_pane_id})`, () =>
      backendClient.peerSend(fromPaneId, target_pane_id, body, corr_id ?? null),
    );
    if (!call.ok) return call.result;
    return jsonResult({
      ok: true,
      message_id: call.value.id,
      sent_at: call.value.sent_at,
      from_pane_id: fromPaneId,
      to_pane_id: target_pane_id,
    });
  },
};

// ─── peer_list ─────────────────────────────────────────────────────────────

const peerListHandler: ToolHandler<Record<string, never>> = {
  name: 'peer_list',
  description:
    'List Claude panes registered with the peers broker. Returns each pane_id with its last_seen_at + summary. Codex/Gemini/bash panes are NOT in this list — query discover_sessions for those.',
  inputSchema: {},
  run: async (): Promise<ToolResult> => {
    const call = await callBackend('peer_list()', () => backendClient.peerList());
    if (!call.ok) return call.result;
    return jsonResult(call.value);
  },
};

// ─── peer_check ────────────────────────────────────────────────────────────

interface PeerCheckArgs {
  pane_id?: string;
}

const peerCheckInput = {
  pane_id: z
    .string()
    .optional()
    .describe(
      'The pane_id whose inbox to drain. Defaults to THEORCHESTRA_PANE_ID env var if set.',
    ),
};

const peerCheckHandler: ToolHandler<PeerCheckArgs> = {
  name: 'peer_check',
  description:
    'Manually poll the inbox for a pane. Returns + atomically marks every undelivered message as delivered. Useful before the channel plugin pushes; once it ships, this is rarely needed.',
  inputSchema: peerCheckInput,
  run: async ({ pane_id }): Promise<ToolResult> => {
    const target = pane_id ?? process.env.THEORCHESTRA_PANE_ID;
    if (!target) {
      return errorResult(
        'pane_id required (and THEORCHESTRA_PANE_ID not set). Pass pane_id explicitly.',
      );
    }
    const call = await callBackend(`peer_check(${target})`, () => backendClient.peerPoll(target));
    if (!call.ok) return call.result;
    return jsonResult(call.value);
  },
};

// ─── set_summary ───────────────────────────────────────────────────────────

interface SetSummaryArgs {
  pane_id?: string;
  summary: string;
}

const setSummaryInput = {
  pane_id: z
    .string()
    .optional()
    .describe('The pane to update. Defaults to THEORCHESTRA_PANE_ID env var.'),
  summary: z
    .string()
    .describe('Short description of what this pane is currently working on (visible to peers).'),
};

const setSummaryHandler: ToolHandler<SetSummaryArgs> = {
  name: 'set_summary',
  description:
    "Advertise what the calling pane is doing. Other Claude panes see this via peer_list. Useful so peers can decide whether to interrupt or hand off work to you.",
  inputSchema: setSummaryInput,
  run: async ({ pane_id, summary }): Promise<ToolResult> => {
    const target = pane_id ?? process.env.THEORCHESTRA_PANE_ID;
    if (!target) {
      return errorResult(
        'pane_id required (and THEORCHESTRA_PANE_ID not set). Pass pane_id explicitly.',
      );
    }
    const call = await callBackend(`set_summary(${target})`, () =>
      backendClient.peerSetSummary(target, summary),
    );
    if (!call.ok) return call.result;
    return textResult(call.value.updated ? `summary updated for ${target}` : `pane ${target} not registered`);
  },
};

// ─── auto_send (hybrid resolver) ───────────────────────────────────────────

interface AutoSendArgs {
  target_pane_id: string;
  body: string;
  corr_id?: string;
}

const autoSendInput = {
  target_pane_id: z.string().describe('The session_id of the destination pane (Claude, Codex, bash, etc.).'),
  body: z.string().describe('The message/prompt body.'),
  corr_id: z.string().optional().describe('Optional correlation id.'),
};

const autoSendHandler: ToolHandler<AutoSendArgs> = {
  name: 'auto_send',
  description:
    "Hybrid send: if target is a registered Claude pane, route through peers broker (instant push when channel plugin is loaded). Otherwise fall back to send_prompt + send_key('enter') so Codex/Gemini/bash still work. CLI-agnostic — use this as your default 'send to another pane' verb when you don't care about the transport.",
  inputSchema: autoSendInput,
  run: async ({ target_pane_id, body, corr_id }): Promise<ToolResult> => {
    // Check broker registry first
    const peers = await callBackend('peer_list (auto_send check)', () => backendClient.peerList());
    let useBroker = false;
    if (peers.ok) {
      useBroker = peers.value.peers.some(
        (p) => p.pane_id === target_pane_id,
      );
    }
    // Note: if peer_list itself failed (e.g. broker disabled), useBroker stays
    // false → fallback path. That's the right degradation.

    if (useBroker) {
      const fromPaneId = process.env.THEORCHESTRA_PANE_ID ?? 'mcp:unknown';
      const call = await callBackend(`auto_send via broker(${target_pane_id})`, () =>
        backendClient.peerSend(fromPaneId, target_pane_id, body, corr_id ?? null),
      );
      if (!call.ok) return call.result;
      return jsonResult({
        ok: true,
        transport: 'broker',
        message_id: call.value.id,
        sent_at: call.value.sent_at,
      });
    }

    // Fallback: type into the pane's PTY + press Enter — same as send_prompt.
    const sendCall = await callBackend(`auto_send fallback prompt(${target_pane_id})`, () =>
      backendClient.sendPrompt(target_pane_id, body),
    );
    if (!sendCall.ok) return sendCall.result;
    // sendPrompt already appends \r so no separate enter key needed (see
    // ws-server.ts:1030 — write text + '\r' is the documented behaviour).
    return jsonResult({
      ok: true,
      transport: 'send_prompt',
      target_pane_id,
      reason: 'target not registered with peers broker (Claude channel plugin not loaded, or non-Claude pane)',
    });
  },
};

export const peersHandlers: ToolHandler<unknown>[] = [
  peerSendHandler as ToolHandler<unknown>,
  peerListHandler as ToolHandler<unknown>,
  peerCheckHandler as ToolHandler<unknown>,
  setSummaryHandler as ToolHandler<unknown>,
  autoSendHandler as ToolHandler<unknown>,
];

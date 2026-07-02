# A2A Protocol

**Scope**: any two panes reachable via the `wezbridge` MCP (Claude Code ↔ Claude Code, Claude Code ↔ Codex, Codex ↔ Codex).

## Envelope

Every peer-to-peer message uses this header on its first line:

```
[A2A from pane-<N> to pane-<M> | corr=<id> | type=request|ack|progress|result|error]
<body — markdown, free-form>
```

- **`from` / `to`**: decimal pane IDs as returned by `mcp__wezbridge__discover_sessions`.
- **`corr`**: opaque correlation id (recommended: task/feature name + short hash, e.g. `T-019-scope`). Stable across the whole exchange.
- **`type`**:
  - `request` — initial ask; include enough context for the peer to act solo.
  - `ack` — received, will work on it. Send fast, cheap.
  - `progress` — heartbeat during long work. Every ~3 min recommended.
  - `result` — final answer; include commit sha / claim id / PR URL if relevant.
  - `error` — aborted; include `reason=…` and whatever diagnostics fit.

Do NOT invent new envelope fields silently. Extend this spec in a PR first.

## Sending

Preferred (v3.5+) — one call that builds the envelope, sends it, and VERIFIES submission:

```js
await mcp__wezbridge__a2a_send({ to_pane: 1, corr: "T-019", type: "request", body: "Hello" });
// -> { ok, submitted: "submitted"|"stuck"|"unknown", corr, ... }
```

Raw form (also verified on v3.5+ servers):

```js
const r = await mcp__wezbridge__send_prompt(target, "[A2A from pane-10 to pane-1 | corr=T-019 | type=request]\nHello\n");
// only if r reports submitted === "stuck":
await mcp__wezbridge__send_key(target, "enter");
```

Two hard rules:

1. **Check the `submitted` field.** `send_prompt`/`a2a_send` (v3.5+) read the pane back and retry Enter automatically; only send `send_key("enter")` when the result reports `stuck`. On PRE-v3.5 servers there is no verification — there, always follow `send_prompt` with `send_key("enter")`; if no response, send a SECOND `enter` — never re-send the prompt (that double-types the body).
2. **Never send bash via `send_text` into a running TUI.** If the pane shows a live `Ctx:` or `gpt-X` status bar, your text is typed as a user prompt, not executed. Ctrl+C first or pick a real shell pane.

## Receiving

When you (a Claude or Codex session) see an envelope in your input:

1. Parse `from`, `corr`, `type`.
2. If `type=request`: optionally send an `ack` on the same `corr`.
3. Do the work. For work > 3 min, send `progress` envelopes on the same `corr`.
4. Send `result` (or `error`) on the same `corr` when done.

## Push-vs-watch asymmetry (MANDATORY)

Claude has the `Monitor` tool; Codex does NOT. Therefore:

- **Every responder MUST push** `type=progress` every ~3 min during long work AND `type=result` on completion. Never assume the requester is watching.
- **Claude requesters** MAY start `Monitor` on the target pane for passive notification.
- **Codex requesters** MUST poll `mcp__wezbridge__read_output(target, 80)` between their own turns (every 1-3 min). No tight loops; fold polling into your normal task cadence.
- **When Claude responds to a Codex request**, remember Codex cannot Monitor you — push proactively regardless of how quick the work is.

## Observability (via `omni-watcher.cjs`)

The watcher scans every Claude pane's tail for envelopes and maintains:

```
pendingA2A: Map<corr, { from, to, type, firstSeen, lastSeen }>
```

- `type=request` opens a `corr`. Duplicate requests are idempotent.
- `type=ack` / `type=progress` refresh `lastSeen` (resets the orphan clock).
- `type=result` / `type=error` close the `corr`.
- Any `corr` older than 1h is swept automatically.

**`peer_orphaned` event**: when the watcher observes `session_removed` for a pane that is still `from` or `to` of an unresolved `corr`, it emits a P1 event with `{corr, dead_peer, survivor}` payload. OmniClaude consumes this event and notifies the survivor:

```
[A2A from OmniClaude to pane-<survivor> | corr=<X> | type=error | reason=peer_orphaned]
pane-<dead> died before resolving corr=<X>. You should stop waiting.
```

## Shared-repo safety

If two peer panes share a repo cwd, prefer different cwds via:

```bash
git worktree add ../<repo>-claude main    # one peer works here
# the other peer keeps the original cwd
```

If you can't set up a worktree, declare ownership explicitly in the envelope header:

```
[A2A from pane-A to pane-B | corr=X | type=request | owns=frontend/]
```

Never edit the other side's files silently.

## Deliberate non-goals for v1.0

- **Heartbeat enforcement by the watcher** — silent peers are not yet auto-flagged (rule exists in the globals, enforcement is Phase 3).
- **Envelope validation** — malformed envelopes are parsed as best-effort and otherwise ignored, not rejected to the sender.
- **Cryptographic signing** — the protocol assumes all panes are locally-trusted. Don't use A2A across trust boundaries.

## Reference

- Spec lives here (authoritative).
- Globals in `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md` include a compressed summary.
- Watcher implementation: `src/omni-watcher.cjs` (`scanA2AEnvelopes`, `pendingA2A`, `peer_orphaned` emission).
- OmniClaude's reaction handler: in its `CLAUDE.md` under "Event Reaction Decision Tree".

<!-- doc-head: T-0576 AC4 — Orca v1.4.209 native agent-launch (PR #21832) evaluated against
wezbridge's current screen-scrape delivery (verified-send.cjs for WezTerm, sendReconnect() in
scripts/mcp-reconnect-broadcast.cjs for Orca). Key terms: orca terminal wait --for tui-idle,
orca terminal send --wait-submit, retry-request idempotency, composerHoldsForeignText,
classifyDelivery. Recommendation: adopt incrementally for Orca-terminal sends via a thin wrapper;
do not touch verified-send.cjs (WezTerm has no equivalent native primitive to switch to).
Read when: deciding whether/how to route wezbridge's Orca-terminal prompt delivery through
native readiness instead of the existing screen-scrape poll loop, or extending
scripts/mcp-reconnect-broadcast.cjs / any future orca-terminal spawn tooling. -->
<!-- /doc-head -->

# Agent-launch (Orca PR #21832) — evaluation for wezbridge (T-0576 AC4)

## Scope and method

This is a **written evaluation, not a rewire**: no dispatch path in wezbridge was changed for
this AC, per the T-0576 brief ("evaluation = written findings + recommendation; do not rewire
existing dispatch paths unless the brief explicitly asks"), and no agent was launched to
produce it (the brief did not require a live trial).

I do not have the Orca repository or PR #21832's diff — Orca is a closed-source desktop app,
not a checkout in this environment. What follows is grounded in the **observable CLI surface
of the Orca binary actually installed on this machine, v1.4.209** (`orca --version` confirmed
below), read via `orca terminal <cmd> --help`, cross-referenced against wezbridge's two existing
screen-scrape delivery implementations. This is the resulting shipped behavior, not the PR's
internal implementation — sufficient to judge fleet adoption, not to review the PR itself.

```
$ orca --version
1.4.209
```

## 1. How Orca v1.4.209 detects readiness

Two CLI primitives, usable independently or composed:

**`orca terminal wait --terminal <handle> --for exit|tui-idle [--timeout-ms <ms>] [--json]`**
Blocks until the terminal's TUI reaches an idle state (`tui-idle`) or the process exits
(`exit`), or `--timeout-ms` elapses. This is Orca's own readiness signal — presumably driven by
the same terminal-rendering internals Orca uses to paint the pane, not a text-pattern match
against scrollback the way wezbridge's `wait_for_idle` MCP tool or `classifyStatus()` in
`scripts/mcp-reconnect-broadcast.cjs` do. For a freshly created terminal running a slow-starting
agent CLI, `--for tui-idle --timeout-ms 30000` is exactly the "readiness check with 30s fallback
timeout" the T-0576 brief describes for PR #21832: readiness is native, and a caller that does
not want to block forever gets a bounded wait with a timeout it controls.

**`orca terminal send --terminal <handle> --text <text> [--enter] [--wait-submit <seconds>]
[--retry-request <id>] [--json]`**
Separates three states that wezbridge currently infers by polling and regex-matching rendered
text: (a) the host **accepted** the input, (b) the agent **observed submission** (the input left
the composer), (c) the agent **started a turn** (per the CLI's own help text: "the result
separates input acceptance from observed submission and turn start"). `--wait-submit <n>`
observes up to `n` seconds for (b)/(c) inline in the same call, returning the queued/accepted
receipt on timeout rather than silently blocking or resending. `--retry-request <id>` makes a
resend after an ambiguous transport failure **idempotent**, bound to "the prompt payload and
exact terminal process incarnation" per the help text — a guarantee wezbridge's own delivery
code does not have today (see below).

```
$ orca terminal wait --help
Usage: orca terminal wait [--terminal <handle>] --for exit|tui-idle [--timeout-ms <ms>] [--json]

$ orca terminal send --help
Usage: orca terminal send [--terminal <handle>] [--text <text>] [--enter] [--interrupt]
  [--wait-submit <seconds>] [--retry-request <id>] [--json]
Notes:
  For a text-plus-Enter agent prompt, the result separates input acceptance from observed
  submission and turn start.
  --wait-submit only observes the accepted prompt for the requested duration; timeout returns
  the queued/input-accepted receipt and never resends.
  After an ambiguous transport failure, reissue the exact command with the reported
  --retry-request ID. The ID is bound to the prompt payload and exact terminal process
  incarnation.
  Older hosts accept the legacy raw input but report provider old-host and do not offer
  idempotent retry or submission observation.
```

Note the last line: **not every paired Orca host supports this.** An older/paired host reports
`provider: old-host` and falls back to "legacy raw input" with no submission observation or
idempotent retry — any adoption has to treat native readiness as an enhancement with a fallback,
not a hard requirement, exactly mirroring how `isDisabledStatus`/`isDisabledSearchResult` in
`src/orca-search.cjs` (this same PR) treat a disabled index as a normal, handled state rather
than an error.

There is no `--wait`/readiness flag on `orca terminal create` itself — a launch flow composes
`create` → `wait --for tui-idle` → `send --wait-submit`, three separate calls, not one.

## 2. Comparison vs wezbridge's current delivery

wezbridge has **two** independent screen-scrape delivery implementations today, one per
transport:

| | WezTerm — `src/verified-send.cjs` | Orca — `sendReconnect()` in `scripts/mcp-reconnect-broadcast.cjs` |
|---|---|---|
| Readiness signal | Regex over `wezterm cli get-text` tail (prompt markers `❯ > ›`, `COMPOSER_PLACEHOLDERS`, `operatorQuestionVisible`) | Regex over `orca terminal read --screen` tail (`STATUS_PATTERNS.working/permission/idle` from `pane-discovery.cjs`) |
| Submission confirmation | `verifyPromptSubmission()`: up to 2 retries, 700–900ms settle, compares composer content against a normalized probe of the sent text | `sendReconnect()`: polls every `pollMs` (default 1000ms) up to `timeoutMs` (default 10000ms), looks for a command-echo line then a `SUCCESS_RE`/`FAIL_RE` match after it |
| Delivery-integrity check | `composerHoldsTail()` — compares the tail of the sent text against rendered output; distinguishes `ok` / `truncated` / `unknown` (collapsed-paste false-positive fix, T-0002) | None — only classifies the *result* text (reconnect succeeded/failed), not whether the *input* arrived intact |
| Foreign-text guard | `composerHoldsForeignText()` / `blockedInput()` — refuses to send over unsent operator text already in the composer, unless `force:true` + audited `why` (T-0242, T-0323) | None — `classifyTarget()` only checks the composer is empty *before* sending, not that it stays exclusively wezbridge's after |
| Retry idempotency | None native — a caller that resends after an ambiguous failure can double-submit | None native — same risk |
| Cost of getting it wrong | Measured, repeatedly, in code comments: 3 panes silently held unsent operator text (2026-08-28), a hybrid operator+envelope prompt sent as one message, a false "truncated" verdict on a collapsed Claude Code paste (2026-07-25) — each became a dedicated guard after a live incident | `sendReconnect()` is younger (T-0569, this week) and already carries its own hard-won fix: matching the result *after the last command echo*, because an old "Successfully reconnected" line already in scrollback was twice misread as this attempt's result |

Every guard in the left/right columns above exists because Orca terminals and WezTerm panes are
both **opaque to the caller except through rendered text** — wezbridge has no signal from
either transport for "my input landed" or "the agent started responding" other than reading the
screen back and pattern-matching it. That is precisely the gap `orca terminal wait --for
tui-idle` and `orca terminal send --wait-submit` close, but **only for the Orca transport** —
WezTerm panes (still the majority of live oversight surface per `orca-census.cjs`'s `by_provider`
counts) get no equivalent from this PR. `wez.cjs`/`verified-send.cjs` has no native-readiness
counterpart to switch to; WezTerm's own CLI (`wezterm cli get-text`) does not expose an
analogous "wait for idle" or "wait for submission" primitive.

## 3. Recommendation

**Adopt, narrowly and incrementally, for the Orca-terminal path only — do not touch
`verified-send.cjs`.**

1. **Do not replace `classifyTarget`'s idle/empty-composer gate.** That gate decides *whether it
   is safe to type into a pane at all* (busy vs idle, foreign text vs empty) — a policy decision
   specific to wezbridge's fleet-safety rules, not something `tui-idle`/`--wait-submit` are
   designed to answer. Native readiness only helps *after* that gate has already said yes.

2. **Where it helps first: a genuine agent-launch flow into a freshly created Orca terminal.**
   wezbridge does not currently have one — `orca terminal create` is used today only inside
   `restoreArgv()` (crash-restore recreation in `src/orca-census.cjs`), and nothing calls it to
   spawn a *new* worker terminal with an initial prompt the way `spawn_session` does for
   WezTerm. If/when such a tool is built (an Orca-terminal analog of the MCP `spawn_session`
   tool), it should use `create` → `wait --for tui-idle --timeout-ms 30000` → `send --enter
   --wait-submit 5` from day one instead of hand-rolling a new screen-scrape readiness loop —
   there is no legacy behavior to preserve there, so there is no migration risk.

3. **Where it helps second, with more caution: `sendReconnect()` in
   `scripts/mcp-reconnect-broadcast.cjs`.** Its current poll loop could be replaced by a single
   `send --enter --wait-submit <n>` call, dropping the manual `pollMs`/`timeoutMs`/command-echo
   regex machinery — *if* `--wait-submit`'s "submission + turn start" signal reliably
   distinguishes "the reconnect command was accepted" from "the reconnect actually
   succeeded/failed", which are different questions (SUCCESS_RE/FAIL_RE classify the *outcome*
   text, not just that a turn started). This needs a live, targeted trial before conversion —
   send one real `/mcp reconnect <server>` with `--wait-submit` against a live Claude pane and
   compare its receipt to what `sendReconnect()` currently reports — which is out of scope for
   this write-up (no live trial was run; T-0576 did not require one). Treat this as a follow-up
   card, not a same-PR change.

4. **Keep a host-capability fallback, unconditionally.** The CLI itself documents that a paired
   host can report `provider: old-host` and silently drop submission-observation and idempotent
   retry. Any wrapper adopting `--wait-submit`/`--retry-request` must handle that response the
   same way `src/orca-search.cjs` handles a disabled index in this same PR: a normal, named,
   non-throwing state — never an unhandled shape that reads as a crash.

5. **`--retry-request` is worth adopting on its own, independent of readiness.** It fixes a real
   gap neither `sendReconnect()` nor `verified-send.cjs` (Orca side) has today: an ambiguous
   transport failure currently has no safe, idempotent resend — a caller either risks a double
   `/mcp reconnect` or gives up. Wiring `--retry-request` into `sendReconnect()`'s error path is
   low-risk (additive, only engages on a failure that is already being reported) and could ship
   without waiting on the broader `--wait-submit` migration.

**Bottom line:** Orca v1.4.209 gives wezbridge a real native alternative to screen-scraping for
the *Orca* transport (terminal `wait`/`send --wait-submit`/`--retry-request`), but it is not a
drop-in replacement for `verified-send.cjs`'s WezTerm guards (foreign-text detection,
delivery-integrity/truncation check) — those solve a different, WezTerm-specific problem with
no native counterpart in this PR. Fleet-wide adoption should start with new Orca-terminal launch
tooling (nothing to migrate, no regression risk) and treat `sendReconnect()`'s conversion as a
separate, trial-verified follow-up card, not a blanket "switch everything to native" decision.

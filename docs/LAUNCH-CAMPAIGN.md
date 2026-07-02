# wezbridge — Open-Source Launch Campaign (DRAFTS)

> **Status: DRAFTS for operator review. Nothing here has been posted.** The operator approves + posts each item.
> Audience: developers using Claude Code / Codex CLI + the MCP ecosystem. **Not** a consumer/IG campaign — no Composio, no Instagram, no paid ads.
> Every claim below is grounded in the verified `README.md`. No invented features. Tone: honest, dev-to-dev, no hype.
> Repo: https://github.com/wolverin0/wezbridge · License: MIT

**Grounding facts used (all from README, do not exceed these):**
- MCP server that controls Claude Code / Codex sessions running in **WezTerm panes** — one long-lived AI session per pane.
- Any session can **spawn, prompt, and read** the others via `mcp__wezbridge__*` tool calls (10 tools: `discover_sessions`, `read_output`, `send_prompt`, `send_key`, `spawn_session`, `split_pane`, `set_tab_title`, `kill_session`, `auto_handoff`, `spawn_ssh_domain`).
- **Zero npm dependencies** — Node built-ins only. **One-command install:** `git clone … && node scripts/install.cjs` (idempotent, `--dry-run`).
- Prereqs: Node 20+, at least one AI CLI (`claude` and/or `codex`), WezTerm.
- **Crash isolation:** one pane dies, peers + orchestrator survive (vs. a single bot monolith).
- **Multi-LLM:** Claude + Codex in the same swarm.
- **`auto_handoff`:** readiness check → `/handoff` → `/clear` → resume when context fills.
- **Optional Telegram remote** (phone control, stable opt-in) + **A2A text-message protocol** between panes.
- Headless daemon on `:4200` — **no browser UI** (the control surface is Claude Code itself). Do NOT pitch a dashboard.
- The **multi-agent layer is experimental** (default OFF) — describe it as such, never as finished.

---

## 1) X / Twitter thread (5 tweets)

**Tweet 1 — hook / pain**
> If you run more than one Claude Code session at a time, you already know the mess: a row of terminal tabs, no clue which one is stuck or waiting on a permission prompt, and you hand-copying context from one into another.
>
> I built a small thing to fix that. 🧵

**Tweet 2 — what it is**
> wezbridge is an MCP server. You run each AI coding session in its own WezTerm pane, and any session can discover, prompt, and read the others through `mcp__wezbridge__*` tool calls.
>
> So one session can drive the whole swarm.

**Tweet 3 — the orchestrator pattern**
> Make one pane the coordinator: it spawns workers, sends them prompts, reads their output, and hands tasks around — Claude *and* Codex in the same swarm.
>
> Crash isolation is the nice part: one pane dies, the coordinator and the other panes keep going.

**Tweet 4 — handoff + optional phone control**
> When a session's context fills up, `auto_handoff` runs a readiness check → /handoff → /clear → resume, so long jobs don't just hit a wall.
>
> Optional: drive the whole thing from your phone over Telegram, with simple text-based messages between panes.

**Tweet 5 — install + link**
> Install is one command and zero npm deps (Node built-ins only):
>
> `git clone https://github.com/wolverin0/wezbridge && cd wezbridge && node scripts/install.cjs`
>
> Needs Node 20+, WezTerm, and Claude Code and/or Codex. MIT-licensed. It's early — feedback and issues very welcome:
> https://github.com/wolverin0/wezbridge

*(Optional 6th tweet if a screenshot/GIF is attached: "Here's the Telegram feed view, one forum topic per worker pane —" + `docs/screenshots/telegram-feed.png`.)*

---

## 2) Reddit posts

### r/ClaudeAI

**Title:** I built an MCP server that lets multiple Claude Code sessions run in parallel and talk to each other (one per terminal pane)

**Body:**
> I kept running 3–4 Claude Code sessions at once and losing track of them — which tab was working, which was stuck on a permission prompt, copy-pasting context between them by hand. So I made **wezbridge**, an MCP server that turns that mess into an actual swarm.
>
> How it works: each session lives in its own WezTerm pane, and every session gets a `mcp__wezbridge__*` tool surface to **discover, prompt, and read** the other panes. That means you can make one session the coordinator — it spawns workers, sends them prompts, reads their output, and routes tasks around.
>
> A few things I leaned on heavily while building with it:
> - **Crash isolation** — if one pane dies, the coordinator and the rest keep going (it's not one big bot process).
> - **`auto_handoff`** — when a session's context fills up it runs a readiness check, then `/handoff` → `/clear` → resume, so a long task doesn't dead-end.
> - **Claude + Codex in the same swarm** if you have both CLIs installed.
> - Optional **Telegram** control so I can poke a session from my phone.
>
> Install is one command with zero npm dependencies (Node built-ins only):
> `git clone https://github.com/wolverin0/wezbridge && cd wezbridge && node scripts/install.cjs`
> Prereqs are Node 20+, WezTerm, and Claude Code and/or Codex. MIT.
>
> Fair warning: the multi-agent persona stuff is experimental and off by default — the stable core is the pane-to-pane tool surface + the Telegram layer. Repo: https://github.com/wolverin0/wezbridge
>
> Curious if others are juggling parallel sessions and how you're managing it — happy to answer questions.

### r/mcp

**Title:** wezbridge — a zero-dependency MCP server for orchestrating multiple Claude Code / Codex sessions across terminal panes

**Body:**
> Sharing an MCP server I've been building: **wezbridge**. The premise is using MCP not to call an external API, but to let AI coding sessions **control each other**.
>
> Each Claude Code / Codex session runs in its own WezTerm pane. The MCP server exposes 10 tools — `discover_sessions`, `read_output`, `send_prompt`, `send_key`, `spawn_session`, `split_pane`, `set_tab_title`, `kill_session`, `auto_handoff`, `spawn_ssh_domain` — so any session can enumerate the others, spawn new ones, send prompts/keys, and read scrollback. One pane becomes an orchestrator over the rest.
>
> Implementation notes that might be relevant to this sub:
> - **Zero npm dependencies** — Node built-ins only. The server is a single `.cjs` registered via `claude mcp add` / Codex's `config.toml`.
> - A small **safety policy** gates the destructive actions (no self-kill, no destructive prompt injection, no over-wide broadcast, etc.).
> - Works **cross-LLM** — Claude and Codex panes coexist in one swarm.
> - There's a simple **text A2A envelope protocol** (`[A2A from pane-N to pane-M | corr=… | type=…]`) for threaded peer messaging.
>
> One-command install (idempotent, has a `--dry-run`): `git clone https://github.com/wolverin0/wezbridge && cd wezbridge && node scripts/install.cjs`. MIT-licensed.
>
> The daemon on `:4200` is headless on purpose — there's no web UI, the control surface is the AI sessions themselves. The persona/multi-agent layer is experimental and default-off.
>
> Repo + tool docs: https://github.com/wolverin0/wezbridge — feedback on the tool design especially welcome.

---

## 3) Show HN

**Title:**
> Show HN: Wezbridge – Orchestrate parallel Claude Code/Codex sessions via MCP

**Body:**
> Wezbridge is an MCP server for running a swarm of long-lived AI coding sessions in parallel — one per WezTerm pane — where any session can spawn, prompt, and read the others through `mcp__wezbridge__*` tool calls.
>
> I built it because I was routinely running several Claude Code sessions at once and there was no good way to coordinate them: I couldn't tell which was stuck, and moving context between them was all manual. With wezbridge, one session can act as a coordinator that spawns workers, dispatches prompts, reads their scrollback, and hands work around. Claude and Codex can run side by side in the same swarm.
>
> Some specifics:
> - **Zero npm dependencies** (Node built-ins only). Install is one command: `git clone … && node scripts/install.cjs` — idempotent, with a `--dry-run`. Needs Node 20+, WezTerm, and at least one of the Claude Code / Codex CLIs.
> - **Crash isolation:** it's not a monolithic bot — if one pane crashes, the coordinator and other panes survive.
> - **`auto_handoff`** runs a readiness check then `/handoff` → `/clear` → resume when a session's context window fills.
> - Optional **Telegram** layer for phone control, and a simple text-based A2A message protocol between panes.
> - The daemon is headless (no web UI on purpose — the control surface is the AI sessions). MIT-licensed.
>
> It's early and the multi-agent persona layer is still experimental (off by default); the stable part is the pane-to-pane tool surface. I'd love feedback on the tool design and on whether the orchestration model holds up for how others run multiple sessions.
>
> Repo: https://github.com/wolverin0/wezbridge

*(Show HN guidance: post from the author account; first comment should add personal context — why built, current limitations, what feedback you want. Don't editorialize the title.)*

---

## 4) Product Hunt

**Tagline (≤60 chars):**
> Orchestrate parallel Claude Code & Codex sessions via MCP

**Description (2–3 sentences):**
> Wezbridge is a zero-dependency MCP server that turns a row of terminal panes into a coordinated swarm of AI coding sessions. Run each Claude Code or Codex session in its own WezTerm pane, and let any session spawn, prompt, and read the others — so one session can orchestrate the rest. Optional phone control over Telegram, with crash isolation and automatic session handoff when context fills.

**Feature bullets:**
- 🧩 **One session drives many** — 10 MCP tools to discover, spawn, prompt, and read sibling panes
- 🔌 **Zero dependencies, one-command install** — `node scripts/install.cjs`, Node built-ins only, idempotent
- 🛡️ **Crash isolation + auto-handoff** — a dead pane doesn't take down the swarm; sessions hand off cleanly when context fills
- 🤖 **Cross-LLM + phone control** — Claude and Codex in one swarm, optional Telegram remote, MIT-licensed

*(First comment / maker note: be upfront that the multi-agent persona layer is experimental and the stable core is the pane-to-pane MCP surface + Telegram.)*

---

## 5) Where-to-submit checklist (prioritized)

> Do these roughly in order. Each is a draft action for the operator — review before submitting.

| # | Channel | Why / priority | Link | Steps |
|---|---|---|---|---|
| 1 | **Official MCP servers registry** | Highest-intent MCP audience; canonical discovery | https://github.com/modelcontextprotocol/servers | Read CONTRIBUTING; most "community servers" land via a PR adding wezbridge to the community list (name, one-line desc, repo link). Follow their current format exactly. |
| 2 | **awesome-mcp-servers** (punkpeye) | Most-trafficked community MCP list | https://github.com/punkpeye/awesome-mcp-servers | Fork → add a bullet under the right category (e.g. "Developer Tools" / "CLI") in their format → PR. Keep the description one line, factual. |
| 3 | **awesome-claude-code** | Targets the exact Claude Code power-user audience | https://github.com/hesreallyhim/awesome-claude-code (verify current canonical repo before submitting) | Fork → add under tooling/integrations → PR. Emphasize the Claude Code multi-session angle. |
| 4 | **GitHub repo topics** (own repo, do first — free) | Improves GitHub search discovery immediately | Repo → ⚙️ next to About | Add topics: `mcp`, `model-context-protocol`, `claude-code`, `codex`, `wezterm`, `ai-agents`, `orchestration`, `developer-tools`. Also set the About blurb + repo URL. |
| 5 | **Show HN** | Burst of dev traffic + feedback | https://news.ycombinator.com/submit | Use the title/body in §3. Post a weekday morning US time. Add the maker first-comment. |
| 6 | **r/mcp + r/ClaudeAI** | Sustained niche reach | (subreddits) | Use §2 posts. Space them out; reply to comments. Read each sub's self-promo rules first. |
| 7 | **Product Hunt** (optional) | Broader reach, lower dev-intent | https://www.producthunt.com/posts/new | Use §4. Needs a logo + a couple screenshots/GIF (`docs/screenshots/`). Schedule; line up the maker comment. |
| 8 | **npm publish** (optional, discoverability) | Lets people find it via npm search even though install is git-clone | https://docs.npmjs.com/cli/commands/npm-publish | Only if it adds value: publish the package (or a thin installer pointing at the repo). **Decision needed** — the README's install path is `git clone` + `node scripts/install.cjs`, so an npm package is purely for search/discovery, not the recommended install. Don't imply `npm i` is the supported path unless you wire that up. |

**Submission hygiene (all channels):**
- One honest line, same facts as the README. No "10x", no "revolutionary".
- Always disclose: multi-agent persona layer is experimental/off-by-default; the stable product is the pane-to-pane MCP surface (+ Telegram).
- Don't claim a web dashboard — the daemon is headless by design.
- Be responsive to comments for the first 24–48h; that's where the real feedback (and stars) come from.

---

### Pre-ship checklist (operator)
- [ ] Repo About blurb + topics set (step 4) — do this first, it's free.
- [ ] README has a screenshot/GIF above the fold for PH/Twitter (reuse `docs/screenshots/telegram-feed.png`).
- [ ] Confirm `node scripts/install.cjs` works from a clean clone on a fresh machine before driving traffic.
- [ ] Decide npm publish: yes/no.
- [ ] Post order: topics → MCP registry/awesome lists → Show HN → Reddit → (optional) PH.

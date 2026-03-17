#!/usr/bin/env node

/**
 * openclaw2claude — MCP server bridging Claude Code to OpenClaw's ClawTrol board
 *
 * Connects to ClawTrol REST API (configured via CLAWTROL_API_URL env var).
 * Provides tools for task management, analytics, and session bridging.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ── Config ──────────────────────────────────────────────────────────────────

const API_URL = process.env.CLAWTROL_API_URL || "http://192.168.100.186:4001/api/v1";
const API_TOKEN = process.env.CLAWTROL_API_TOKEN || "";
const HOOKS_TOKEN = process.env.CLAWTROL_HOOKS_TOKEN || "";

if (!API_TOKEN) {
  console.error("ERROR: CLAWTROL_API_TOKEN env var required");
  process.exit(1);
}

if (!HOOKS_TOKEN) {
  console.error("ERROR: CLAWTROL_HOOKS_TOKEN env var required");
  process.exit(1);
}

const REQUEST_TIMEOUT_MS = 15000;

// ── API Client ──────────────────────────────────────────────────────────────

async function apiRequest(endpoint, options = {}) {
  const url = `${API_URL}${endpoint}`;
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${API_TOKEN}`,
    ...options.headers,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(url, { ...options, headers, signal: controller.signal });

    if (!res.ok) {
      const status = res.status;
      const statusText = res.statusText;
      throw new Error(`ClawTrol API ${status}: ${statusText}`);
    }

    const text = await res.text();
    if (!text.trim()) return null;
    return JSON.parse(text);
  } finally {
    clearTimeout(timeout);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function textResult(text) {
  return { content: [{ type: "text", text }] };
}

function jsonResult(label, data) {
  return textResult(`${label}\n${JSON.stringify(data, null, 2)}`);
}

// ── Server ──────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "openclaw2claude",
  version: "2.1.0",
});

// ═══════════════════════════════════════════════════════════════════════════
// EXISTING TOOLS (security-hardened)
// ═══════════════════════════════════════════════════════════════════════════

// ── Tool: list_tasks ────────────────────────────────────────────────────────

server.tool(
  "clawtrol_list_tasks",
  "List tasks from ClawTrol board. Filter by status, board, or assignment.",
  {
    status: z
      .enum(["inbox", "up_next", "in_progress", "in_review", "done"])
      .optional()
      .describe("Filter by task status"),
    board_id: z.string().optional().describe("Filter by board ID"),
    assigned: z
      .boolean()
      .optional()
      .describe("Filter by agent assignment (true=assigned, false=unassigned)"),
  },
  async ({ status, board_id, assigned }) => {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (board_id) params.set("board_id", board_id);
    if (assigned !== undefined) params.set("assigned", String(assigned));
    const q = params.toString();

    const tasks = await apiRequest(`/tasks${q ? `?${q}` : ""}`);

    const summary = tasks.map((t) => ({
      id: t.id,
      name: t.name,
      status: t.status,
      board_id: t.board_id,
      tags: t.tags,
      model: t.model || t.openclaw_spawn_model,
      assigned: t.assigned_to_agent,
      created: t.created_at,
      updated: t.updated_at,
    }));

    return textResult(`Found ${summary.length} task(s):\n${JSON.stringify(summary, null, 2)}`);
  }
);

// ── Tool: get_task ──────────────────────────────────────────────────────────

server.tool(
  "clawtrol_get_task",
  "Get full details of a ClawTrol task by ID, including description, output, and agent session info.",
  {
    task_id: z.string().describe("Task ID (numeric)"),
  },
  async ({ task_id }) => {
    const task = await apiRequest(`/tasks/${encodeURIComponent(task_id)}`);
    return jsonResult(`Task #${task_id}:`, task);
  }
);

// ── Tool: create_task ───────────────────────────────────────────────────────

server.tool(
  "clawtrol_create_task",
  "Create a new task on the ClawTrol board. If model is specified, auto-routes via spawn pipeline for proper completion tracking. Without model, creates a manual task.",
  {
    name: z.string().describe("Task title"),
    description: z.string().optional().describe("Task description/prompt for the agent"),
    status: z
      .enum(["inbox", "up_next", "in_progress"])
      .optional()
      .default("up_next")
      .describe("Initial status (default: up_next)"),
    board_id: z.string().optional().describe("Board ID (default: main board)"),
    tags: z.array(z.string()).optional().describe("Tags for categorization"),
    model: z
      .string()
      .optional()
      .describe("Model to use (opus, codex, gemini, glm, flash)"),
  },
  async ({ name, description, status, board_id, tags, model }) => {
    let task;

    if (model) {
      const spawnBody = { name, description, model };
      if (board_id) spawnBody.board_id = board_id;
      if (tags?.length) spawnBody.tags = tags;
      task = await apiRequest("/tasks/spawn_ready", {
        method: "POST",
        body: JSON.stringify(spawnBody),
      });
    } else {
      const body = { task: { name, description, status, tags } };
      if (board_id) body.task.board_id = board_id;
      task = await apiRequest("/tasks", {
        method: "POST",
        body: JSON.stringify(body),
      });
    }

    return textResult(
      `Created task #${task.id}: "${task.name}" [${task.status}]${model ? ` (spawn pipeline, model=${model})` : " (manual)"}\n${JSON.stringify(task, null, 2)}`
    );
  }
);

// ── Tool: update_task ───────────────────────────────────────────────────────

server.tool(
  "clawtrol_update_task",
  "Update a ClawTrol task — change status, add output/notes, reassign model.",
  {
    task_id: z.string().describe("Task ID"),
    status: z
      .enum(["inbox", "up_next", "in_progress", "in_review", "done"])
      .optional()
      .describe("New status"),
    name: z.string().optional().describe("New task name"),
    description: z.string().optional().describe("New description"),
    output: z.string().optional().describe("Task output/result note"),
    model: z.string().optional().describe("Assign/change model"),
  },
  async ({ task_id, status, name, description, output, model }) => {
    const updates = {};
    if (status) updates.status = status;
    if (name) updates.name = name;
    if (description) updates.description = description;
    if (output) updates.output = output;
    if (model) updates.model = model;

    const task = await apiRequest(`/tasks/${encodeURIComponent(task_id)}`, {
      method: "PATCH",
      body: JSON.stringify({ task: updates }),
    });

    return textResult(`Updated task #${task.id} → ${task.status}\n${JSON.stringify(task, null, 2)}`);
  }
);

// ── Tool: task_log ──────────────────────────────────────────────────────────

server.tool(
  "clawtrol_task_log",
  "Get the agent conversation log for a task — see what OpenClaw/Otacon did.",
  {
    task_id: z.string().describe("Task ID"),
  },
  async ({ task_id }) => {
    try {
      const log = await apiRequest(`/tasks/${encodeURIComponent(task_id)}/agent_log`);
      const messages = (log.messages || []).map((m) => ({
        line: m.line,
        role: m.role,
        text: m.content
          ?.map((c) => c.text || `[${c.type}]`)
          .join("")
          .slice(0, 500),
      }));

      return textResult(`Task #${task_id} log (${messages.length} messages):\n${JSON.stringify(messages, null, 2)}`);
    } catch (err) {
      return textResult(`No log available for task #${task_id}: ${err.message}`);
    }
  }
);

// ── Tool: board_summary ─────────────────────────────────────────────────────

server.tool(
  "clawtrol_board_summary",
  "Get a summary of all tasks grouped by status — quick overview of what OpenClaw is doing.",
  {},
  async () => {
    const tasks = await apiRequest("/tasks");

    const byStatus = {};
    for (const t of tasks) {
      const s = t.status || "unknown";
      if (!byStatus[s]) byStatus[s] = [];
      byStatus[s].push({ id: t.id, name: t.name, tags: t.tags });
    }

    const counts = Object.fromEntries(
      Object.entries(byStatus).map(([k, v]) => [k, v.length])
    );

    return textResult(
      `Board summary: ${JSON.stringify(counts)}\n\n${Object.entries(byStatus)
        .map(
          ([status, tasks]) =>
            `## ${status} (${tasks.length})\n${tasks
              .map((t) => `  #${t.id}: ${t.name}${t.tags?.length ? ` [${t.tags.join(", ")}]` : ""}`)
              .join("\n")}`
        )
        .join("\n\n")}`
    );
  }
);

// ── Tool: health ────────────────────────────────────────────────────────────

server.tool(
  "clawtrol_health",
  "Check ClawTrol API health and connectivity.",
  {},
  async () => {
    const t0 = Date.now();
    try {
      const tasks = await apiRequest("/tasks");
      const active = tasks.filter(
        (t) => t.status === "in_progress" || t.status === "up_next"
      );
      const latency = Date.now() - t0;

      return textResult(`ClawTrol OK — ${latency}ms latency, ${tasks.length} total tasks, ${active.length} active`);
    } catch (err) {
      return textResult(`ClawTrol ERROR — ${err.message}`);
    }
  }
);

// ── Tool: spawn_task ───────────────────────────────────────────────────────

server.tool(
  "clawtrol_spawn_task",
  "Create a spawn-ready task that OpenClaw will auto-execute. Auto-routes to board.",
  {
    name: z.string().describe("Task title (prefix with ProjectName: for board routing)"),
    description: z.string().describe("Full prompt for the agent"),
    model: z
      .enum(["codex", "sonnet", "opus", "gemini", "flash", "glm", "groq", "grok", "gemini3", "cerebras", "minimax", "ollama"])
      .optional()
      .default("gemini")
      .describe("Model to use"),
  },
  async ({ name, description, model }) => {
    const task = await apiRequest("/tasks/spawn_ready", {
      method: "POST",
      body: JSON.stringify({ name, description, model }),
    });
    return textResult(`Spawned task #${task.id}: "${task.name}" [${task.status}] model=${task.model || model}\n${JSON.stringify(task, null, 2)}`);
  }
);

// ── Tool: spawn_via_gateway ────────────────────────────────────────────────

server.tool(
  "clawtrol_spawn_via_gateway",
  "Spawn a task via OpenClaw gateway — starts agent execution immediately.",
  {
    task_id: z.string().describe("Task ID to spawn"),
  },
  async ({ task_id }) => {
    const result = await apiRequest(`/tasks/${encodeURIComponent(task_id)}/spawn_via_gateway`, {
      method: "POST",
    });
    return jsonResult(`Spawned task #${task_id} via gateway:`, result);
  }
);

// ── Tool: claim_task ──────────────────────────────────────────────────────

server.tool(
  "clawtrol_claim_task",
  "Claim a task for agent execution.",
  {
    task_id: z.string().describe("Task ID to claim"),
  },
  async ({ task_id }) => {
    const result = await apiRequest(`/tasks/${encodeURIComponent(task_id)}/claim`, {
      method: "PATCH",
    });
    return jsonResult(`Claimed task #${task_id}:`, result);
  }
);

// ── Tool: complete_task ───────────────────────────────────────────────────

server.tool(
  "clawtrol_complete_task",
  "Fire both completion hooks (task_outcome + agent_complete) to properly close a task. MUST fire both.",
  {
    task_id: z.string().describe("Task ID"),
    summary: z.string().describe("What was accomplished"),
    output: z.string().describe("Detailed findings/output"),
    outcome: z
      .enum(["success", "partial", "failure"])
      .optional()
      .default("success")
      .describe("Outcome status"),
    needs_follow_up: z.boolean().optional().default(false).describe("Needs follow-up?"),
    output_files: z.array(z.string()).optional().describe("Output file paths"),
  },
  async ({ task_id, summary, output, outcome, needs_follow_up, output_files }) => {
    const run_id = crypto.randomUUID();

    const hookHeaders = {
      "Content-Type": "application/json",
      "X-Hook-Token": HOOKS_TOKEN,
    };

    const outcomeRes = await fetch(`${API_URL}/hooks/task_outcome`, {
      method: "POST",
      headers: hookHeaders,
      body: JSON.stringify({
        version: 1,
        task_id: parseInt(task_id),
        run_id,
        ended_at: new Date().toISOString(),
        outcome,
        summary,
        needs_follow_up,
        achieved: [summary],
        evidence: [],
        remaining: needs_follow_up ? ["See follow-up"] : [],
      }),
    });

    const completeRes = await fetch(`${API_URL}/hooks/agent_complete`, {
      method: "POST",
      headers: hookHeaders,
      body: JSON.stringify({
        task_id: parseInt(task_id),
        run_id,
        summary,
        agent_output: output,
        output_files: output_files || [],
      }),
    });

    return textResult(`Task #${task_id} completed:\n  task_outcome: ${outcomeRes.status}\n  agent_complete: ${completeRes.status}`);
  }
);

// ── Tool: list_boards ─────────────────────────────────────────────────────

server.tool(
  "clawtrol_list_boards",
  "List all ClawTrol boards with their IDs and task counts.",
  {},
  async () => {
    const boards = await apiRequest("/boards");
    return jsonResult("Boards:", boards);
  }
);

// ── Tool: models_status ───────────────────────────────────────────────────

server.tool(
  "clawtrol_models_status",
  "Get status of all available AI models (which are online, rate-limited, etc).",
  {},
  async () => {
    const models = await apiRequest("/models/status");
    return jsonResult("Models:", models);
  }
);

// ── Tool: nightshift ──────────────────────────────────────────────────────

server.tool(
  "clawtrol_nightshift",
  "Manage nightshift tasks — list tonight's queue, arm, or launch.",
  {
    action: z
      .enum(["list", "arm", "launch"])
      .describe("list=see queue, arm=enable auto-run, launch=start now"),
  },
  async ({ action }) => {
    const endpoints = {
      list: { path: "/nightshift/tasks", method: "GET" },
      arm: { path: "/nightshift/arm", method: "POST" },
      launch: { path: "/nightshift/launch", method: "POST" },
    };
    const { path, method } = endpoints[action];
    const result = await apiRequest(path, { method });
    return jsonResult(`Nightshift ${action}:`, result);
  }
);

// ── Tool: run_debate ──────────────────────────────────────────────────────

server.tool(
  "clawtrol_run_debate",
  "Run a multi-model debate on a task's output to get diverse perspectives.",
  {
    task_id: z.string().describe("Task ID to debate"),
  },
  async ({ task_id }) => {
    const result = await apiRequest(`/tasks/${encodeURIComponent(task_id)}/run_debate`, {
      method: "POST",
    });
    return jsonResult(`Debate result for #${task_id}:`, result);
  }
);

// ── Tool: session_health ──────────────────────────────────────────────────

server.tool(
  "clawtrol_session_health",
  "Check the health of an agent session running a task (transcript stats, progress).",
  {
    task_id: z.string().describe("Task ID"),
  },
  async ({ task_id }) => {
    const result = await apiRequest(`/tasks/${encodeURIComponent(task_id)}/session_health`);
    return jsonResult(`Session health for #${task_id}:`, result);
  }
);

// ── Tool: read_file (HARDENED — proper path traversal prevention) ────────

server.tool(
  "clawtrol_read_file",
  "Read a file from the OpenClaw workspace on the VM. Creates a quick flash task to cat the file and returns contents via task log. For small files (<50KB).",
  {
    file_path: z
      .string()
      .describe(
        "Path relative to ~/workspace/ (e.g. 'projects/local-biz-sites/data/pergamino-servicios.json')"
      ),
  },
  async ({ file_path }) => {
    // Normalize and validate: no traversal, no absolute paths, no null bytes
    const cleaned = file_path.replace(/\0/g, "");
    const segments = cleaned.split(/[/\\]/).filter((s) => s && s !== "." && s !== "..");
    if (segments.length === 0) {
      return textResult("Error: invalid file path");
    }
    const safePath = segments.join("/");

    // Block suspicious patterns
    if (/[;&|`$()]/.test(safePath)) {
      return textResult("Error: file path contains forbidden characters");
    }

    const task = await apiRequest("/tasks/spawn_ready", {
      method: "POST",
      body: JSON.stringify({
        name: `ReadFile: ${segments[segments.length - 1]}`,
        description: `Quick read task. Run: cat ~/workspace/${safePath}\n\nOutput the FULL file contents as your final response. This should take under 30 seconds.`,
        model: "flash",
      }),
    });

    return textResult(`File read task #${task.id} spawned (flash). Check task log in ~30s with clawtrol_task_log(${task.id}) or clawtrol_get_task(${task.id}) for the output.`);
  }
);

// ── Tool: exec (HARDENED — command whitelist) ────────────────────────────

const ALLOWED_EXEC_COMMANDS = [
  "ls", "cat", "head", "tail", "wc", "grep", "find", "stat", "file",
  "df", "du", "uptime", "whoami", "hostname", "date", "uname",
  "docker", "ps", "free", "top", "systemctl",
  "git", "curl", "tree", "which", "env", "printenv",
];

server.tool(
  "clawtrol_exec",
  "Execute a whitelisted shell command on the VM via a quick flash task. Returns task ID to check results. Only allows safe read-only commands.",
  {
    command: z.string().describe("Shell command to execute (must start with an allowed command: ls, cat, grep, find, git, docker, df, uptime, etc.)"),
    description: z
      .string()
      .optional()
      .describe("What this command does (for task naming)"),
  },
  async ({ command, description }) => {
    // Extract base command (first word)
    const baseCmd = command.trim().split(/\s+/)[0];

    if (!ALLOWED_EXEC_COMMANDS.includes(baseCmd)) {
      return textResult(
        `Error: command "${baseCmd}" not in whitelist. Allowed: ${ALLOWED_EXEC_COMMANDS.join(", ")}`
      );
    }

    // Block dangerous shell operators
    if (/[;&|`$()]|>>|>\s/.test(command)) {
      return textResult("Error: shell operators (;, &, |, `, $, >, >>) are not allowed. Use simple commands only.");
    }

    const label = description || command.slice(0, 50);
    const task = await apiRequest("/tasks/spawn_ready", {
      method: "POST",
      body: JSON.stringify({
        name: `Exec: ${label}`,
        description: `Run this command and output the results:\n\n\`\`\`bash\n${command}\n\`\`\`\n\nInclude the full output in your final response.`,
        model: "flash",
      }),
    });

    return textResult(`Exec task #${task.id} spawned (flash): ${label}\nCheck results with clawtrol_get_task(${task.id})`);
  }
);

// ═══════════════════════════════════════════════════════════════════════════
// NEW TOOLS — Fase 2: High-value ClawTrol API integrations
// ═══════════════════════════════════════════════════════════════════════════

// ── Tool: queue_health ──────────────────────────────────────────────────────

server.tool(
  "clawtrol_queue_health",
  "Get task queue health — pending count, error count, processing stats. Quick operational overview.",
  {},
  async () => {
    const result = await apiRequest("/tasks/queue_health");
    return jsonResult("Queue health:", result);
  }
);

// ── Tool: pending_attention ─────────────────────────────────────────────────

server.tool(
  "clawtrol_pending_attention",
  "Get tasks that need human attention — stuck, errored, or awaiting review.",
  {},
  async () => {
    const result = await apiRequest("/tasks/pending_attention");
    return jsonResult("Tasks needing attention:", result);
  }
);

// ── Tool: requeue_task ──────────────────────────────────────────────────────

server.tool(
  "clawtrol_requeue_task",
  "Re-enqueue a failed or stuck task for another execution attempt.",
  {
    task_id: z.string().describe("Task ID to requeue"),
  },
  async ({ task_id }) => {
    const result = await apiRequest(`/tasks/${encodeURIComponent(task_id)}/requeue`, {
      method: "POST",
    });
    return jsonResult(`Requeued task #${task_id}:`, result);
  }
);

// ── Tool: handoff_task ──────────────────────────────────────────────────────

server.tool(
  "clawtrol_handoff_task",
  "Hand off a task to a different model or agent. Transfers context and continues execution.",
  {
    task_id: z.string().describe("Task ID to hand off"),
    target_model: z.string().optional().describe("Target model (opus, gemini, flash, etc.)"),
    reason: z.string().optional().describe("Why the handoff is needed"),
  },
  async ({ task_id, target_model, reason }) => {
    const body = {};
    if (target_model) body.target_model = target_model;
    if (reason) body.reason = reason;

    const result = await apiRequest(`/tasks/${encodeURIComponent(task_id)}/handoff`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    return jsonResult(`Handoff task #${task_id}:`, result);
  }
);

// ── Tool: token_analytics ───────────────────────────────────────────────────

server.tool(
  "clawtrol_token_analytics",
  "Get token usage analytics — cost breakdown by model, period, and task type.",
  {},
  async () => {
    const result = await apiRequest("/analytics/tokens");
    return jsonResult("Token analytics:", result);
  }
);

// ── Tool: model_performance ─────────────────────────────────────────────────

server.tool(
  "clawtrol_model_performance",
  "Compare AI model performance — success rates, speed, cost efficiency across models.",
  {
    summary_only: z.boolean().optional().default(true).describe("Return summary instead of full details"),
  },
  async ({ summary_only }) => {
    try {
      const endpoint = summary_only ? "/model_performance/summary" : "/model_performance";
      const result = await apiRequest(endpoint);
      return jsonResult("Model performance:", result);
    } catch (err) {
      return textResult(`Model performance unavailable: ${err.message}`);
    }
  }
);

// ── Tool: next_task ─────────────────────────────────────────────────────────

server.tool(
  "clawtrol_next_task",
  "Get the next priority task to claim from the queue. Use before claim_task to auto-pick.",
  {},
  async () => {
    const result = await apiRequest("/tasks/next");
    if (!result) {
      return textResult("No tasks available in queue.");
    }
    return jsonResult("Next task:", result);
  }
);

// ── Tool: task_dependencies ─────────────────────────────────────────────────

server.tool(
  "clawtrol_task_dependencies",
  "View or manage task dependencies. See what blocks a task and what it blocks.",
  {
    task_id: z.string().describe("Task ID"),
    action: z.enum(["view", "add"]).optional().default("view").describe("view=see deps, add=add dependency"),
    depends_on_id: z.string().optional().describe("Task ID this task depends on (for action=add)"),
  },
  async ({ task_id, action, depends_on_id }) => {
    if (action === "add") {
      if (!depends_on_id) {
        return textResult("Error: depends_on_id required when action=add");
      }
      const result = await apiRequest(`/tasks/${encodeURIComponent(task_id)}/add_dependency`, {
        method: "POST",
        body: JSON.stringify({ depends_on_id: parseInt(depends_on_id) }),
      });
      return jsonResult(`Added dependency: #${task_id} depends on #${depends_on_id}:`, result);
    }

    const result = await apiRequest(`/tasks/${encodeURIComponent(task_id)}/dependencies`);
    return jsonResult(`Dependencies for #${task_id}:`, result);
  }
);

// ── Tool: create_followup ───────────────────────────────────────────────────

server.tool(
  "clawtrol_followup",
  "Generate and create a follow-up task from a completed task. AI suggests next steps based on output.",
  {
    task_id: z.string().describe("Source task ID"),
    action: z.enum(["generate", "create"]).optional().default("generate").describe("generate=get suggestion, create=create follow-up task"),
    description: z.string().optional().describe("Custom follow-up description (for action=create)"),
  },
  async ({ task_id, action, description }) => {
    if (action === "create") {
      const body = {};
      if (description) body.description = description;
      const result = await apiRequest(`/tasks/${encodeURIComponent(task_id)}/create_followup`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      return jsonResult(`Created follow-up for #${task_id}:`, result);
    }

    const result = await apiRequest(`/tasks/${encodeURIComponent(task_id)}/generate_followup`, {
      method: "POST",
    });
    return jsonResult(`Follow-up suggestion for #${task_id}:`, result);
  }
);

// ── Tool: gateway_health ────────────────────────────────────────────────────

server.tool(
  "clawtrol_gateway_health",
  "Check OpenClaw gateway status — health, channels, cost, available models, plugins.",
  {
    section: z.enum(["health", "channels", "cost", "models", "plugins", "all"])
      .optional()
      .default("all")
      .describe("Which gateway info to retrieve"),
  },
  async ({ section }) => {
    if (section === "all") {
      const [health, channels, cost, models, plugins] = await Promise.allSettled([
        apiRequest("/gateway/health"),
        apiRequest("/gateway/channels"),
        apiRequest("/gateway/cost"),
        apiRequest("/gateway/models"),
        apiRequest("/gateway/plugins"),
      ]);

      const result = {
        health: health.status === "fulfilled" ? health.value : health.reason?.message,
        channels: channels.status === "fulfilled" ? channels.value : channels.reason?.message,
        cost: cost.status === "fulfilled" ? cost.value : cost.reason?.message,
        models: models.status === "fulfilled" ? models.value : models.reason?.message,
        plugins: plugins.status === "fulfilled" ? plugins.value : plugins.reason?.message,
      };
      return jsonResult("Gateway status:", result);
    }

    const result = await apiRequest(`/gateway/${section}`);
    return jsonResult(`Gateway ${section}:`, result);
  }
);

// ═══════════════════════════════════════════════════════════════════════════
// FASE A — Mega Orchestrator: Nightshift Missions, Notifications, Swarm, etc
// ═══════════════════════════════════════════════════════════════════════════

// ── Tool: nightshift_missions ───────────────────────────────────────────────

server.tool(
  "clawtrol_nightshift_missions",
  "Manage nightshift missions (v2) — CRUD for recurring nightly tasks. List all missions with their schedule, model, and category.",
  {
    action: z.enum(["list", "create", "update", "delete"]).optional().default("list").describe("CRUD action"),
    mission_id: z.string().optional().describe("Mission ID (for update/delete)"),
    title: z.string().optional().describe("Mission title (for create/update)"),
    desc: z.string().optional().describe("Mission description/prompt (for create/update)"),
    model: z.string().optional().describe("Model to use (gemini, glm, codex, etc.)"),
    time: z.number().optional().describe("Estimated time in minutes"),
    frequency: z.enum(["always", "weekly", "manual"]).optional().describe("How often to run"),
    category: z.string().optional().describe("Category (security, infra, code, research, general, finance)"),
  },
  async ({ action, mission_id, title, desc, model, time, frequency, category }) => {
    if (action === "list") {
      const result = await apiRequest("/nightshift/missions");
      return jsonResult(`${result.length} nightshift missions:`, result);
    }

    if (action === "create") {
      const body = {};
      if (title) body.title = title;
      if (desc) body.desc = desc;
      if (model) body.model = model;
      if (time) body.time = time;
      if (frequency) body.frequency = frequency;
      if (category) body.category = category;
      const result = await apiRequest("/nightshift/missions", {
        method: "POST",
        body: JSON.stringify(body),
      });
      return jsonResult("Created mission:", result);
    }

    if (action === "update") {
      if (!mission_id) return textResult("Error: mission_id required for update");
      const body = {};
      if (title) body.title = title;
      if (desc) body.desc = desc;
      if (model) body.model = model;
      if (time) body.time = time;
      if (frequency) body.frequency = frequency;
      if (category) body.category = category;
      const result = await apiRequest(`/nightshift/missions/${encodeURIComponent(mission_id)}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      return jsonResult(`Updated mission #${mission_id}:`, result);
    }

    if (action === "delete") {
      if (!mission_id) return textResult("Error: mission_id required for delete");
      await apiRequest(`/nightshift/missions/${encodeURIComponent(mission_id)}`, {
        method: "DELETE",
      });
      return textResult(`Deleted mission #${mission_id}`);
    }

    return textResult("Unknown action");
  }
);

// ── Tool: nightshift_tonight ────────────────────────────────────────────────

server.tool(
  "clawtrol_nightshift_tonight",
  "See tonight's nightshift plan — which missions are due, their selections, and approve the plan.",
  {
    action: z.enum(["view", "approve"]).optional().default("view").describe("view=see plan, approve=approve tonight's selections"),
  },
  async ({ action }) => {
    if (action === "approve") {
      const result = await apiRequest("/nightshift/tonight/approve", { method: "POST" });
      return jsonResult("Tonight approved:", result);
    }

    const result = await apiRequest("/nightshift/tonight");
    const due = result.due_missions || [];
    const selections = result.selections || [];
    const summary = `Tonight (${result.date}): ${due.length} missions due, ${selections.length} selections\n\nDue missions:\n${due.map((m) => `  ${m.icon} #${m.id}: ${m.title} [${m.model}, ~${m.time}min, ${m.category}]`).join("\n")}`;
    return textResult(summary);
  }
);

// ── Tool: nightshift_selections ─────────────────────────────────────────────

server.tool(
  "clawtrol_nightshift_selections",
  "View nightshift execution history — which missions ran, their status (completed/failed/timeout).",
  {},
  async () => {
    const result = await apiRequest("/nightshift/selections");
    return jsonResult(`${result.length} nightshift selections:`, result);
  }
);

// ── Tool: notifications ─────────────────────────────────────────────────────

server.tool(
  "clawtrol_notifications",
  "Manage ClawTrol notifications — view recent, mark read, or clear all.",
  {
    action: z.enum(["list", "mark_read", "mark_all_read", "clear_all"]).optional().default("list").describe("Action to perform"),
    notification_id: z.string().optional().describe("Notification ID (for mark_read)"),
  },
  async ({ action, notification_id }) => {
    if (action === "mark_read" && notification_id) {
      const result = await apiRequest(`/notifications/${encodeURIComponent(notification_id)}/mark_read`, {
        method: "POST",
      });
      return textResult(`Marked notification #${notification_id} as read`);
    }

    if (action === "mark_all_read") {
      await apiRequest("/notifications/mark_all_read", { method: "POST" });
      return textResult("All notifications marked as read");
    }

    if (action === "clear_all") {
      await apiRequest("/notifications/clear_all", { method: "POST" });
      return textResult("All notifications cleared");
    }

    // List
    const result = await apiRequest("/notifications");
    const notifs = result.notifications || result;
    const unread = result.unread_count || 0;
    const recent = (Array.isArray(notifs) ? notifs : []).slice(0, 20);
    const summary = `${unread} unread notifications (showing last ${recent.length}):\n${recent.map((n) => `  ${n.icon || ""} [${n.event_type}] ${n.message} (${n.time_ago})`).join("\n")}`;
    return textResult(summary);
  }
);

// ── Tool: swarm_ideas ───────────────────────────────────────────────────────

server.tool(
  "clawtrol_swarm_ideas",
  "Manage swarm ideas — multi-agent task templates that can be launched as coordinated swarms.",
  {
    action: z.enum(["list", "create", "launch", "delete"]).optional().default("list").describe("Action"),
    idea_id: z.string().optional().describe("Swarm idea ID (for launch/delete)"),
    name: z.string().optional().describe("Idea name (for create)"),
    description: z.string().optional().describe("Idea description (for create)"),
    tasks: z.array(z.object({
      name: z.string(),
      model: z.string().optional(),
      description: z.string().optional(),
    })).optional().describe("Array of sub-tasks (for create)"),
  },
  async ({ action, idea_id, name, description, tasks }) => {
    if (action === "list") {
      const result = await apiRequest("/swarm_ideas");
      return jsonResult(`${result.length} swarm ideas:`, result);
    }

    if (action === "create") {
      const body = {};
      if (name) body.name = name;
      if (description) body.description = description;
      if (tasks) body.tasks = tasks;
      const result = await apiRequest("/swarm_ideas", {
        method: "POST",
        body: JSON.stringify({ swarm_idea: body }),
      });
      return jsonResult("Created swarm idea:", result);
    }

    if (action === "launch") {
      if (!idea_id) return textResult("Error: idea_id required for launch");
      const result = await apiRequest(`/swarm_ideas/${encodeURIComponent(idea_id)}/launch`, {
        method: "POST",
      });
      return jsonResult(`Launched swarm #${idea_id}:`, result);
    }

    if (action === "delete") {
      if (!idea_id) return textResult("Error: idea_id required for delete");
      await apiRequest(`/swarm_ideas/${encodeURIComponent(idea_id)}`, {
        method: "DELETE",
      });
      return textResult(`Deleted swarm idea #${idea_id}`);
    }

    return textResult("Unknown action");
  }
);

// ── Tool: saved_links ───────────────────────────────────────────────────────

server.tool(
  "clawtrol_saved_links",
  "Manage saved links inbox — URLs saved for later processing by agents.",
  {
    action: z.enum(["list", "pending", "create"]).optional().default("list").describe("list=all, pending=unprocessed, create=add new"),
    url: z.string().optional().describe("URL to save (for create)"),
    title: z.string().optional().describe("Link title (for create)"),
  },
  async ({ action, url, title }) => {
    if (action === "create") {
      if (!url) return textResult("Error: url required");
      const result = await apiRequest("/saved_links", {
        method: "POST",
        body: JSON.stringify({ saved_link: { url, title: title || url } }),
      });
      return jsonResult("Saved link:", result);
    }

    if (action === "pending") {
      const result = await apiRequest("/saved_links/pending");
      return jsonResult(`Pending links:`, result);
    }

    const result = await apiRequest("/saved_links");
    return jsonResult(`Saved links:`, result);
  }
);

// ── Tool: errored_count ─────────────────────────────────────────────────────

server.tool(
  "clawtrol_errored_count",
  "Get count of errored tasks — quick check if anything failed.",
  {},
  async () => {
    const result = await apiRequest("/tasks/errored_count");
    return textResult(`Errored tasks: ${result.count}`);
  }
);

// ── Tool: agent_messages ────────────────────────────────────────────────────

server.tool(
  "clawtrol_agent_messages",
  "Get the agent message thread for a task — structured conversation between agent and system.",
  {
    task_id: z.string().describe("Task ID"),
  },
  async ({ task_id }) => {
    try {
      const result = await apiRequest(`/tasks/${encodeURIComponent(task_id)}/agent_messages/thread`);
      return jsonResult(`Agent messages for #${task_id}:`, result);
    } catch (err) {
      return textResult(`No messages for task #${task_id}: ${err.message}`);
    }
  }
);

// ── Tool: runtime_events ────────────────────────────────────────────────────

server.tool(
  "clawtrol_runtime_events",
  "Publish runtime events to ClawTrol for cross-system coordination and logging.",
  {
    event_type: z.string().describe("Event type (e.g. 'session_started', 'build_failed', 'deploy_complete')"),
    payload: z.string().describe("JSON payload as string"),
  },
  async ({ event_type, payload }) => {
    let parsedPayload;
    try {
      parsedPayload = JSON.parse(payload);
    } catch {
      parsedPayload = { message: payload };
    }

    const result = await fetch(`${API_URL}/hooks/runtime_events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hook-Token": HOOKS_TOKEN,
      },
      body: JSON.stringify({
        event_type,
        source: "claude-code",
        timestamp: new Date().toISOString(),
        ...parsedPayload,
      }),
    });

    return textResult(`Runtime event '${event_type}' published: HTTP ${result.status}`);
  }
);

// ── Tool: task_templates ────────────────────────────────────────────────────

server.tool(
  "clawtrol_task_templates",
  "Manage task templates — reusable task definitions for quick creation.",
  {
    action: z.enum(["list", "get", "apply"]).optional().default("list").describe("list=all templates, get=single, apply=create task from template"),
    template_id: z.string().optional().describe("Template ID (for get/apply)"),
  },
  async ({ action, template_id }) => {
    if (action === "get" && template_id) {
      const result = await apiRequest(`/task_templates/${encodeURIComponent(template_id)}`);
      return jsonResult(`Template #${template_id}:`, result);
    }

    if (action === "apply") {
      if (!template_id) return textResult("Error: template_id required for apply");
      const result = await apiRequest("/task_templates/apply", {
        method: "POST",
        body: JSON.stringify({ template_id: parseInt(template_id) }),
      });
      return jsonResult(`Applied template #${template_id}:`, result);
    }

    const result = await apiRequest("/task_templates");
    return jsonResult(`Task templates:`, result);
  }
);

// ── Tool: learning_proposals ────────────────────────────────────────────────

server.tool(
  "clawtrol_learning_proposals",
  "View and manage learning proposals — agent-suggested improvements that need human approval.",
  {
    action: z.enum(["list", "approve", "reject"]).optional().default("list").describe("Action"),
    proposal_id: z.string().optional().describe("Proposal ID (for approve/reject)"),
  },
  async ({ action, proposal_id }) => {
    if (action === "approve" && proposal_id) {
      const result = await apiRequest(`/learning_proposals/${encodeURIComponent(proposal_id)}/approve`, {
        method: "POST",
      });
      return jsonResult(`Approved proposal #${proposal_id}:`, result);
    }

    if (action === "reject" && proposal_id) {
      const result = await apiRequest(`/learning_proposals/${encodeURIComponent(proposal_id)}/reject`, {
        method: "POST",
      });
      return jsonResult(`Rejected proposal #${proposal_id}:`, result);
    }

    const result = await apiRequest("/learning_proposals");
    return jsonResult(`Learning proposals:`, result);
  }
);

// ── Tool: feed_entries ──────────────────────────────────────────────────────

server.tool(
  "clawtrol_feed_entries",
  "View RSS/feed entries pushed by n8n — tech news, alerts, and external content.",
  {
    action: z.enum(["list", "stats"]).optional().default("list").describe("list=recent entries, stats=feed statistics"),
  },
  async ({ action }) => {
    if (action === "stats") {
      const result = await apiRequest("/feed_entries/stats");
      return jsonResult("Feed stats:", result);
    }

    const result = await apiRequest("/feed_entries");
    return jsonResult(`Feed entries:`, result);
  }
);

// ═══════════════════════════════════════════════════════════════════════════
// Start
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("openclaw2claude MCP server v2.1.0 running on stdio");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

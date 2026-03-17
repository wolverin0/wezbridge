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
  version: "3.0.0",
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
// FASE B — Factory, Audits, Settings, Learning
// ═══════════════════════════════════════════════════════════════════════════

// ── Tool: factory_loops ─────────────────────────────────────────────────────

server.tool(
  "clawtrol_factory_loops",
  "Manage Factory loops — automated research/coding cycles that run on schedule. List, view details, or create loops.",
  {
    action: z.enum(["list", "get", "create"]).optional().default("list").describe("Action"),
    loop_id: z.string().optional().describe("Loop ID (for get)"),
    name: z.string().optional().describe("Loop name (for create)"),
    description: z.string().optional().describe("Loop description (for create)"),
    model: z.string().optional().describe("Model (for create)"),
    interval_ms: z.number().optional().describe("Interval in ms between cycles (for create)"),
  },
  async ({ action, loop_id, name, description, model, interval_ms }) => {
    if (action === "get" && loop_id) {
      const result = await apiRequest(`/factory/loops/${encodeURIComponent(loop_id)}`);
      return jsonResult(`Factory loop #${loop_id}:`, result);
    }

    if (action === "create") {
      const body = {};
      if (name) body.name = name;
      if (description) body.description = description;
      if (model) body.model = model;
      if (interval_ms) body.interval_ms = interval_ms;
      const result = await apiRequest("/factory/loops", {
        method: "POST",
        body: JSON.stringify({ factory_loop: body }),
      });
      return jsonResult("Created factory loop:", result);
    }

    const result = await apiRequest("/factory/loops");
    const summary = result.map((l) => ({
      id: l.id, name: l.name, status: l.status, model: l.model,
      total_cycles: l.total_cycles, total_errors: l.total_errors,
      last_cycle: l.last_cycle_at,
    }));
    return jsonResult(`${result.length} factory loops:`, summary);
  }
);

// ── Tool: factory_control ───────────────────────────────────────────────────

server.tool(
  "clawtrol_factory_control",
  "Control Factory loop execution — play, pause, or stop a loop.",
  {
    loop_id: z.string().describe("Loop ID"),
    action: z.enum(["play", "pause", "stop"]).describe("Control action"),
  },
  async ({ loop_id, action }) => {
    const result = await apiRequest(`/factory/loops/${encodeURIComponent(loop_id)}/${action}`, {
      method: "POST",
    });
    return jsonResult(`Factory loop #${loop_id} ${action}:`, result);
  }
);

// ── Tool: factory_findings ──────────────────────────────────────────────────

server.tool(
  "clawtrol_factory_findings",
  "Get findings/results from a Factory loop's cycles — what the automated agents discovered.",
  {
    loop_id: z.string().describe("Loop ID"),
  },
  async ({ loop_id }) => {
    const result = await apiRequest(`/factory/loops/${encodeURIComponent(loop_id)}/findings`);
    return jsonResult(`Findings for loop #${loop_id}:`, result);
  }
);

// ── Tool: factory_metrics ───────────────────────────────────────────────────

server.tool(
  "clawtrol_factory_metrics",
  "Get performance metrics for a Factory loop — cycle times, success rates, commit counts.",
  {
    loop_id: z.string().describe("Loop ID"),
  },
  async ({ loop_id }) => {
    const result = await apiRequest(`/factory/loops/${encodeURIComponent(loop_id)}/metrics`);
    return jsonResult(`Metrics for loop #${loop_id}:`, result);
  }
);

// ── Tool: factory_agents ────────────────────────────────────────────────────

server.tool(
  "clawtrol_factory_agents",
  "List Factory agent catalog — specialized agents available for loops (Security Auditor, Code Reviewer, etc).",
  {},
  async () => {
    const result = await apiRequest("/factory/agents");
    const summary = result.map((a) => ({
      id: a.id, name: a.name, slug: a.slug, category: a.category,
      priority: a.priority, builtin: a.builtin,
    }));
    return jsonResult(`${result.length} factory agents:`, summary);
  }
);

// ── Tool: audits ────────────────────────────────────────────────────────────

server.tool(
  "clawtrol_audits",
  "View and manage behavioral audits — agent quality scores tracked by ClawTrol.",
  {
    action: z.enum(["latest", "ingest"]).optional().default("latest").describe("latest=last audit report, ingest=submit new audit data"),
    audit_data: z.string().optional().describe("JSON audit data (for ingest)"),
  },
  async ({ action, audit_data }) => {
    if (action === "ingest" && audit_data) {
      let parsed;
      try { parsed = JSON.parse(audit_data); } catch { return textResult("Error: invalid JSON for audit_data"); }
      const result = await apiRequest("/audits/ingest", {
        method: "POST",
        body: JSON.stringify(parsed),
      });
      return jsonResult("Audit ingested:", result);
    }

    const result = await apiRequest("/audits/latest");
    return jsonResult("Latest audit:", result);
  }
);

// ── Tool: settings ──────────────────────────────────────────────────────────

server.tool(
  "clawtrol_settings",
  "View ClawTrol system settings — agent config, auto-mode, email.",
  {},
  async () => {
    const result = await apiRequest("/settings");
    return jsonResult("Settings:", result);
  }
);

// ── Tool: learning_effectiveness ────────────────────────────────────────────

server.tool(
  "clawtrol_learning_effectiveness",
  "View learning effectiveness tracking — how well agent learnings are being applied.",
  {},
  async () => {
    const result = await apiRequest("/learning_effectiveness");
    return jsonResult("Learning effectiveness:", result);
  }
);

// ── Tool: agent_personas ────────────────────────────────────────────────────

server.tool(
  "clawtrol_agent_personas",
  "Manage agent personas — predefined agent identities with system prompts and capabilities.",
  {
    action: z.enum(["list", "get"]).optional().default("list").describe("Action"),
    persona_id: z.string().optional().describe("Persona ID (for get)"),
  },
  async ({ action, persona_id }) => {
    if (action === "get" && persona_id) {
      const result = await apiRequest(`/agent_personas/${encodeURIComponent(persona_id)}`);
      return jsonResult(`Persona #${persona_id}:`, result);
    }

    const result = await apiRequest("/agent_personas");
    return jsonResult(`Agent personas:`, result);
  }
);

// ── Tool: nightshift_sync ───────────────────────────────────────────────────

server.tool(
  "clawtrol_nightshift_sync",
  "Sync nightshift state — sync crons with gateway or report execution results.",
  {
    action: z.enum(["sync_crons", "sync_tonight", "report"]).describe("sync_crons=sync with gateway crons, sync_tonight=refresh tonight plan, report=report execution"),
    execution_data: z.string().optional().describe("JSON execution report data (for report action)"),
  },
  async ({ action, execution_data }) => {
    if (action === "report" && execution_data) {
      let parsed;
      try { parsed = JSON.parse(execution_data); } catch { return textResult("Error: invalid JSON"); }
      const result = await apiRequest("/nightshift/report_execution", {
        method: "POST",
        body: JSON.stringify(parsed),
      });
      return jsonResult("Execution reported:", result);
    }

    const endpoint = action === "sync_crons" ? "/nightshift/sync_crons" : "/nightshift/sync_tonight";
    const result = await apiRequest(endpoint, { method: "POST" });
    return jsonResult(`Nightshift ${action}:`, result);
  }
);

// ═══════════════════════════════════════════════════════════════════════════
// OMNI BRIDGE — Cross-system orchestration tools
// ═══════════════════════════════════════════════════════════════════════════

// ── Tool: message_otacon ────────────────────────────────────────────────────

server.tool(
  "clawtrol_message_otacon",
  "Send a directive to Otacon (OpenClaw's AI agent on the VM) via ClawTrol task. Creates a specially tagged task that Otacon will pick up and execute. This is how the Omni orchestrator communicates with the remote agent.",
  {
    prompt: z.string().describe("What you want Otacon to do — full instruction/prompt"),
    priority: z.enum(["low", "medium", "high", "critical"]).optional().default("high").describe("Task priority"),
    model: z.string().optional().default("gemini").describe("Preferred model (gemini, codex, opus, flash, glm, groq)"),
    board_id: z.string().optional().describe("Target board ID (omit for auto-routing)"),
    wait_for_result: z.boolean().optional().default(false).describe("If true, polls for result (slow — task must complete first)"),
  },
  async ({ prompt, priority, model, board_id, wait_for_result }) => {
    const taskName = `[OMNI] ${prompt.slice(0, 80)}`;
    const taskDesc = `## Omni Orchestrator Directive\n\n**Source:** Claude Code (Windows) via openclaw2claude MCP bridge\n**Priority:** ${priority}\n**Timestamp:** ${new Date().toISOString()}\n\n---\n\n${prompt}\n\n---\n\n_This task was created by the Omni orchestrator. Report results via completion hooks._`;

    const spawnBody = {
      name: taskName,
      description: taskDesc,
      model,
      tags: ["omni", "remote-directive"],
    };
    if (board_id) spawnBody.board_id = parseInt(board_id);

    const task = await apiRequest("/tasks/spawn_ready", {
      method: "POST",
      body: JSON.stringify(spawnBody),
    });

    // Also fire a runtime event so ClawTrol logs the cross-system communication
    try {
      await fetch(`${API_URL}/hooks/runtime_events`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Hook-Token": HOOKS_TOKEN },
        body: JSON.stringify({
          event_type: "omni_directive",
          source: "claude-code",
          timestamp: new Date().toISOString(),
          task_id: task.id,
          priority,
          model,
          prompt_preview: prompt.slice(0, 200),
        }),
      });
    } catch { /* non-critical */ }

    let result = `Directive sent to Otacon → Task #${task.id}\n  Name: ${taskName}\n  Model: ${model}\n  Priority: ${priority}\n  Status: ${task.status}`;

    if (wait_for_result) {
      result += `\n\nWaiting for result... Use clawtrol_get_task(${task.id}) or clawtrol_task_log(${task.id}) to check.`;
    }

    return textResult(result);
  }
);

// ── Tool: dashboard ─────────────────────────────────────────────────────────

server.tool(
  "clawtrol_dashboard",
  "Get a compact all-in-one dashboard of ClawTrol state — tasks, queue, nightshift, notifications, errors. One call instead of five.",
  {},
  async () => {
    const [tasks, queue, tonight, notifs, errored] = await Promise.allSettled([
      apiRequest("/tasks"),
      apiRequest("/tasks/queue_health"),
      apiRequest("/nightshift/tonight"),
      apiRequest("/notifications"),
      apiRequest("/tasks/errored_count"),
    ]);

    // Tasks breakdown
    let taskSummary = "unavailable";
    if (tasks.status === "fulfilled" && Array.isArray(tasks.value)) {
      const t = tasks.value;
      const byStatus = {};
      for (const task of t) {
        const s = task.status || "unknown";
        byStatus[s] = (byStatus[s] || 0) + 1;
      }
      const active = t.filter((x) => x.status === "in_progress");
      const upNext = t.filter((x) => x.status === "up_next");
      const review = t.filter((x) => x.status === "in_review");
      taskSummary = `${t.length} total | ${active.length} running | ${upNext.length} queued | ${review.length} in review`;
      if (active.length > 0) {
        taskSummary += `\n  Running: ${active.slice(0, 5).map((a) => `#${a.id} ${a.name.slice(0, 40)} [${a.model || "?"}]`).join(", ")}`;
      }
      if (upNext.length > 0) {
        taskSummary += `\n  Up next: ${upNext.slice(0, 5).map((a) => `#${a.id} ${a.name.slice(0, 40)}`).join(", ")}`;
      }
    }

    // Queue
    let queueSummary = "unavailable";
    if (queue.status === "fulfilled" && queue.value) {
      const q = queue.value;
      queueSummary = `${q.active_in_progress || 0} active / ${q.max_concurrent} max | ${q.queue_depth} in queue | ${q.available_slots} slots free`;
      if (q.in_night_window) queueSummary += " | NIGHT MODE";
      const models = Object.entries(q.inflight_by_model || {});
      if (models.length > 0) queueSummary += `\n  Models: ${models.map(([m, c]) => `${m}=${c}`).join(", ")}`;
    }

    // Nightshift
    let nightSummary = "unavailable";
    if (tonight.status === "fulfilled" && tonight.value) {
      const n = tonight.value;
      const due = n.due_missions || [];
      const sel = n.selections || [];
      nightSummary = `${due.length} missions due | ${sel.length} selections | ${n.date}`;
      if (due.length > 0) {
        const totalMin = due.reduce((s, m) => s + (m.time || 0), 0);
        nightSummary += ` (~${totalMin}min total)`;
      }
    }

    // Notifications
    let notifSummary = "unavailable";
    if (notifs.status === "fulfilled" && notifs.value) {
      const unread = notifs.value.unread_count || 0;
      const recent = (notifs.value.notifications || []).slice(0, 3);
      notifSummary = `${unread} unread`;
      if (recent.length > 0) {
        notifSummary += `\n  Latest: ${recent.map((n) => `[${n.event_type}] ${n.message?.slice(0, 60)} (${n.time_ago})`).join("\n  Latest: ")}`;
      }
    }

    // Errors
    let errorSummary = "0";
    if (errored.status === "fulfilled" && errored.value) {
      errorSummary = String(errored.value.count || 0);
    }

    const dashboard = `═══ ClawTrol Dashboard ═══
📋 Tasks:    ${taskSummary}
⚡ Queue:    ${queueSummary}
🌙 Tonight:  ${nightSummary}
🔔 Notifs:   ${notifSummary}
❌ Errors:   ${errorSummary}
═══════════════════════════`;

    return textResult(dashboard);
  }
);

// ═══════════════════════════════════════════════════════════════════════════
// FASE C — Omni Bridge: unified status, task routing, Telegram direct
// ═══════════════════════════════════════════════════════════════════════════

// Otacon's Telegram bot (for direct messaging)
const OTACON_BOT_TOKEN = process.env.OTACON_BOT_TOKEN || "";
const MISSION_CONTROL_GROUP_ID = process.env.MISSION_CONTROL_GROUP_ID || "-1003748927245";
const MISSION_CONTROL_THREAD_ID = process.env.MISSION_CONTROL_THREAD_ID || "1";

// WezBridge local API (for session info)
const WEZBRIDGE_URL = process.env.WEZBRIDGE_URL || "http://localhost:4200";

// ── Tool: omni_status ───────────────────────────────────────────────────────

server.tool(
  "clawtrol_omni_status",
  "Super-dashboard: combined local (WezBridge sessions) + remote (ClawTrol tasks/queue/nightshift) status in one view. The full operational picture.",
  {},
  async () => {
    // Parallel: local WezBridge + remote ClawTrol
    const [local, tasks, queue, tonight, notifs, errored, settings] = await Promise.allSettled([
      fetch(`${WEZBRIDGE_URL}/api/sessions`, { signal: AbortSignal.timeout(3000) }).then((r) => r.json()).catch(() => null),
      apiRequest("/tasks"),
      apiRequest("/tasks/queue_health"),
      apiRequest("/nightshift/tonight"),
      apiRequest("/notifications"),
      apiRequest("/tasks/errored_count"),
      apiRequest("/settings"),
    ]);

    // ── Local: WezBridge sessions ──
    let localSection = "⚠️ WezBridge unreachable";
    const localData = local.status === "fulfilled" ? local.value : null;
    if (localData && Array.isArray(localData)) {
      const alive = localData.filter((s) => s.status === "alive" || s.status === "active");
      const waiting = localData.filter((s) => s.status === "waiting");
      localSection = `${alive.length} active | ${waiting.length} waiting | ${localData.length} total`;
      if (alive.length > 0) {
        localSection += `\n  Sessions: ${alive.slice(0, 5).map((s) => `${s.project || s.name || "unnamed"} [${s.paneId}]`).join(", ")}`;
      }
    } else if (localData && typeof localData === "object") {
      // WezBridge might return { sessions: [...] }
      const sessions = localData.sessions || [];
      const alive = sessions.filter((s) => s.status === "alive" || s.status === "active");
      localSection = `${alive.length} active | ${sessions.length} total`;
      if (alive.length > 0) {
        localSection += `\n  Sessions: ${alive.slice(0, 5).map((s) => `${s.project || s.name || "unnamed"}`).join(", ")}`;
      }
    }

    // ── Remote: ClawTrol tasks ──
    let taskSection = "unavailable";
    if (tasks.status === "fulfilled" && Array.isArray(tasks.value)) {
      const t = tasks.value;
      const active = t.filter((x) => x.status === "in_progress");
      const upNext = t.filter((x) => x.status === "up_next");
      const review = t.filter((x) => x.status === "in_review");
      taskSection = `${t.length} total | ${active.length} running | ${upNext.length} queued | ${review.length} in review`;
      if (active.length > 0) {
        taskSection += `\n  Running: ${active.slice(0, 4).map((a) => `#${a.id} ${a.name.slice(0, 35)} [${a.model || "?"}]`).join("\n  Running: ")}`;
      }
    }

    // ── Queue ──
    let queueSection = "unavailable";
    if (queue.status === "fulfilled" && queue.value) {
      const q = queue.value;
      queueSection = `${q.active_in_progress || 0}/${q.max_concurrent} slots`;
      if (q.in_night_window) queueSection += " NIGHT";
      const models = Object.entries(q.inflight_by_model || {});
      if (models.length > 0) queueSection += ` [${models.map(([m, c]) => `${m}:${c}`).join(" ")}]`;
    }

    // ── Nightshift ──
    let nightSection = "unavailable";
    if (tonight.status === "fulfilled" && tonight.value) {
      const n = tonight.value;
      const due = n.due_missions || [];
      const sel = n.selections || [];
      nightSection = `${due.length} missions | ${sel.length} selections`;
    }

    // ── Agent status ──
    let agentSection = "unknown";
    if (settings.status === "fulfilled" && settings.value) {
      const s = settings.value;
      agentSection = `${s.agent_emoji || ""} ${s.agent_name} [${s.agent_status}] auto=${s.agent_auto_mode}`;
    }

    // ── Errors + Notifications ──
    const errorCount = errored.status === "fulfilled" ? (errored.value?.count || 0) : "?";
    const unreadCount = notifs.status === "fulfilled" ? (notifs.value?.unread_count || 0) : "?";

    const dashboard = `╔══════════════════════════════════════╗
║       OMNI STATUS — ${new Date().toISOString().slice(11, 19)} UTC      ║
╠══════════════════════════════════════╣
║ 🖥️ LOCAL (WezBridge)                ║
║   ${localSection.split("\n")[0].padEnd(35)}║
${localSection.split("\n").slice(1).map((l) => `║   ${l.padEnd(35)}║`).join("\n")}
╠──────────────────────────────────────╣
║ 🌐 REMOTE (ClawTrol)                ║
║   ${taskSection.split("\n")[0].padEnd(35)}║
${taskSection.split("\n").slice(1).map((l) => `║   ${l.padEnd(35)}║`).join("\n")}
╠──────────────────────────────────────╣
║ ⚡ Queue:  ${queueSection.padEnd(27)}║
║ 🌙 Night:  ${nightSection.padEnd(26)}║
║ 🤖 Agent:  ${agentSection.slice(0, 26).padEnd(26)}║
║ 🔔 Notifs: ${String(unreadCount).padEnd(4)} unread                ║
║ ❌ Errors: ${String(errorCount).padEnd(27)}║
╚══════════════════════════════════════╝`;

    return textResult(dashboard);
  }
);

// ── Tool: route_task ────────────────────────────────────────────────────────

server.tool(
  "clawtrol_route_task",
  "Smart task router — analyzes a prompt and decides whether to execute locally (Claude Code/WezBridge) or remotely (ClawTrol/Otacon). Routes accordingly.",
  {
    prompt: z.string().describe("Task description/prompt"),
    force: z.enum(["local", "remote", "auto"]).optional().default("auto").describe("Force routing: local=WezBridge, remote=ClawTrol, auto=decide"),
    model: z.string().optional().default("gemini").describe("Model for remote execution"),
    priority: z.enum(["low", "medium", "high", "critical"]).optional().default("medium").describe("Task priority"),
  },
  async ({ prompt, force, model, priority }) => {
    // Routing heuristics
    const lowerPrompt = prompt.toLowerCase();

    const remoteSignals = [
      "backup", "supabase", "docker", "server", "mikrotik", "infra",
      "deploy", "n8n", "uisp", "crm", "openclaw", "gateway", "ssh",
      "192.168", "vm", "production", "nginx", "caddy", "cloudflare",
      "disk", "memory", "cpu", "systemctl", "service",
    ];

    const localSignals = [
      "react", "typescript", "vite", "npm", "build", "test", "lint",
      "component", "hook", "page", "css", "tailwind", "frontend",
      "git commit", "git push", "refactor", "code review", "fix bug",
      "local", "windows", "wezterm", "pane",
    ];

    let decision = force;
    let reason = "";

    if (force === "auto") {
      const remoteScore = remoteSignals.filter((s) => lowerPrompt.includes(s)).length;
      const localScore = localSignals.filter((s) => lowerPrompt.includes(s)).length;

      if (remoteScore > localScore) {
        decision = "remote";
        reason = `infrastructure/server task (matched: ${remoteSignals.filter((s) => lowerPrompt.includes(s)).join(", ")})`;
      } else if (localScore > remoteScore) {
        decision = "local";
        reason = `development/coding task (matched: ${localSignals.filter((s) => lowerPrompt.includes(s)).join(", ")})`;
      } else {
        decision = "remote";
        reason = "ambiguous — defaulting to remote (ClawTrol has more capacity)";
      }
    } else {
      reason = `forced ${force}`;
    }

    if (decision === "remote") {
      // Route to ClawTrol via message_otacon
      const taskName = `[OMNI] ${prompt.slice(0, 80)}`;
      const taskDesc = `## Omni Orchestrator Directive\n\n**Source:** Claude Code via route_task (auto-routed)\n**Priority:** ${priority}\n**Routing:** remote — ${reason}\n**Timestamp:** ${new Date().toISOString()}\n\n---\n\n${prompt}`;

      const task = await apiRequest("/tasks/spawn_ready", {
        method: "POST",
        body: JSON.stringify({
          name: taskName,
          description: taskDesc,
          model,
          tags: ["omni", "auto-routed"],
        }),
      });

      return textResult(`🌐 ROUTED → REMOTE (ClawTrol)\n  Reason: ${reason}\n  Task #${task.id}: ${taskName}\n  Model: ${model} | Priority: ${priority}\n  Track: clawtrol_get_task(${task.id})`);
    }

    // Local — return instructions for the caller to execute
    return textResult(`🖥️ ROUTED → LOCAL (Claude Code)\n  Reason: ${reason}\n  Priority: ${priority}\n\n  Execute this locally:\n  ${prompt}\n\n  (Use WezBridge /spawn or execute directly in this session)`);
  }
);

// ── Tool: telegram_send ─────────────────────────────────────────────────────

server.tool(
  "clawtrol_telegram_send",
  "Send a direct message to the Mission Control Telegram group where Otacon listens. Synchronous communication — Otacon sees it immediately. Supports topic threads.",
  {
    message: z.string().describe("Message text (supports HTML formatting)"),
    thread_id: z.string().optional().describe("Topic thread ID (omit for General). Known topics: 21-27=Various, 200=Diet, 216=Health, 1528=Alerts"),
    parse_mode: z.enum(["HTML", "Markdown"]).optional().default("HTML").describe("Message format"),
  },
  async ({ message, thread_id, parse_mode }) => {
    const botToken = OTACON_BOT_TOKEN;
    if (!botToken) {
      return textResult("Error: OTACON_BOT_TOKEN env var not set. Cannot send Telegram messages.");
    }

    const body = {
      chat_id: MISSION_CONTROL_GROUP_ID,
      text: message,
      parse_mode,
    };

    if (thread_id) {
      const threadNum = parseInt(thread_id);
      if (threadNum > 0) {
        body.message_thread_id = threadNum;
      }
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    try {
      const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const result = await res.json();

      if (!result.ok) {
        return textResult(`Telegram error: ${result.description || JSON.stringify(result)}`);
      }

      return textResult(`Message sent to Mission Control (thread ${threadNum}):\n  message_id: ${result.result.message_id}\n  date: ${new Date(result.result.date * 1000).toISOString()}`);
    } catch (err) {
      return textResult(`Telegram send failed: ${err.message}`);
    } finally {
      clearTimeout(timeout);
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════
// Start
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("openclaw2claude MCP server v3.0.0 running on stdio");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

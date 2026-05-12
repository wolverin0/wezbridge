const http = require("http");
const fs = require("fs");
const path = require("path");

const PHASE_PATTERNS = [
  /\bphase\s+(\d+)\b/gi,
  /\bphase\s*(\d+)\s*[:.-]/gi,
  /\b(?:starting|start|beginning|begin)\s+phase\s+(\d+)\b/gi,
  /\b(?:completed|complete|finished|finish)\s+phase\s+(\d+)\b/gi,
  /\bP(\d+)\b/g,
];

function detectPhaseTransition(scrollbackText, currentPhase) {
  if (!scrollbackText) {
    return null;
  }

  const matches = [];
  for (const pattern of PHASE_PATTERNS) {
    pattern.lastIndex = 0;
    let match = pattern.exec(scrollbackText);
    while (match) {
      const phase = Number.parseInt(match[1], 10);
      if (Number.isInteger(phase) && phase > currentPhase) {
        matches.push({ index: match.index, phase });
      }
      match = pattern.exec(scrollbackText);
    }
  }

  if (matches.length === 0) {
    return null;
  }

  matches.sort((left, right) => left.index - right.index);
  return matches[matches.length - 1].phase;
}

function buildBriefingUpdate({ fromPaneId, toPaneId, corrId, body }) {
  return `[A2A from pane-${fromPaneId} to pane-${toPaneId} | corr=${corrId} | type=progress]\nBRIEFING UPDATE\n${body}`;
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (response) => {
        let responseBody = "";

        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          responseBody += chunk;
        });
        response.on("end", () => {
          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(
              new Error(
                `Dashboard read failed with ${response.statusCode}: ${responseBody}`
              )
            );
            return;
          }

          try {
            resolve(responseBody ? JSON.parse(responseBody) : {});
          } catch (error) {
            reject(error);
          }
        });
      })
      .on("error", reject);
  });
}

function postJson(url, payload) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const body = JSON.stringify(payload);
    const request = http.request(
      {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || 80,
        path: `${parsedUrl.pathname}${parsedUrl.search}`,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (response) => {
        let responseBody = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          responseBody += chunk;
        });
        response.on("end", () => {
          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(
              new Error(
                `Dashboard write failed with ${response.statusCode}: ${responseBody}`
              )
            );
            return;
          }
          try {
            resolve(responseBody ? JSON.parse(responseBody) : {});
          } catch (error) {
            reject(error);
          }
        });
      }
    );

    request.on("error", reject);
    request.write(body);
    request.end();
  });
}

function writeActiveTask(projectPath, phase) {
  const activeTaskPath = path.join(projectPath, "active-task.md");
  const content = [
    `# Active task`,
    ``,
    `phase: ${phase}`,
    `updated_at: ${new Date().toISOString()}`,
    ``,
  ].join("\n");

  fs.writeFileSync(activeTaskPath, content, "utf8");
}

function startSidecarWatcher({
  sidecarPaneId,
  coderPaneId,
  projectPath,
  dashboardBaseUrl,
  intervalMs = 45_000,
}) {
  let stopped = false;
  let currentPhase = 0;
  let lastTransitionAt = Date.now();
  const corrId = `sidecar-${sidecarPaneId}-${coderPaneId}`;

  async function tick() {
    if (stopped) {
      return;
    }

    try {
      const scrollbackUrl = new URL(
        `/api/panes/${coderPaneId}/scrollback`,
        dashboardBaseUrl
      ).toString();
      const scrollbackResponse = await getJson(scrollbackUrl);
      const scrollbackText =
        scrollbackResponse.scrollbackText ??
        scrollbackResponse.text ??
        scrollbackResponse.output ??
        "";
      const nextPhase = detectPhaseTransition(scrollbackText, currentPhase);

      if (nextPhase !== null) {
        currentPhase = nextPhase;
        lastTransitionAt = Date.now();
        writeActiveTask(projectPath, currentPhase);

        const envelope = buildBriefingUpdate({
          fromPaneId: sidecarPaneId,
          toPaneId: coderPaneId,
          corrId,
          body: `Detected transition to phase ${currentPhase}. Auditing phase ${
            currentPhase - 1
          } while coder advances.`,
        });

        await postJson(new URL("/api/send_prompt", dashboardBaseUrl).toString(), {
          paneId: coderPaneId,
          text: envelope,
        });
      } else if (Date.now() - lastTransitionAt >= 300_000) {
        const envelope = buildBriefingUpdate({
          fromPaneId: sidecarPaneId,
          toPaneId: coderPaneId,
          corrId,
          body: `No phase transition detected for 5 minutes at phase ${currentPhase}. Review for stuck work.`,
        });

        lastTransitionAt = Date.now();
        await postJson(new URL("/api/send_prompt", dashboardBaseUrl).toString(), {
          paneId: coderPaneId,
          text: envelope,
        });
      }
    } catch (_error) {
      // Watchers are sidecars; failed polls should not take down the MCP process.
    } finally {
      if (!stopped) {
        setTimeout(tick, intervalMs);
      }
    }
  }

  const timer = setTimeout(tick, 0);

  return function stopSidecarWatcher() {
    stopped = true;
    clearTimeout(timer);
  };
}

module.exports = {
  buildBriefingUpdate,
  detectPhaseTransition,
  startSidecarWatcher,
};

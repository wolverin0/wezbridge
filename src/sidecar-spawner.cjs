const http = require("http");

const MCP_TOOL_DEFINITION = {
  name: "spawn_sidecar",
  description: "Spawn a Layer-2 look-ahead sidecar for multi-phase coding tasks.",
  inputSchema: {
    type: "object",
    properties: {
      coderPaneId: {
        type: "number",
        description: "Pane id of the coder session to observe.",
      },
      projectPath: {
        type: "string",
        description: "Absolute path to the project being worked on.",
      },
      phases: {
        type: "array",
        items: { type: "string" },
        description: "Ordered task phases. Sidecar activates only with 4+ phases.",
      },
      dashboardBaseUrl: {
        type: "string",
        description: "Base URL for the wezbridge dashboard API.",
      },
    },
    required: ["coderPaneId", "projectPath", "phases", "dashboardBaseUrl"],
    additionalProperties: false,
  },
};

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
                `Dashboard spawn failed with ${response.statusCode}: ${responseBody}`
              )
            );
            return;
          }

          if (!responseBody) {
            resolve({});
            return;
          }

          try {
            resolve(JSON.parse(responseBody));
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

async function spawnSidecar({ coderPaneId, projectPath, phases, dashboardBaseUrl }) {
  if (!Array.isArray(phases) || phases.length < 4) {
    return { skipped: true };
  }

  const spawnUrl = new URL("/api/spawn", dashboardBaseUrl).toString();
  const response = await postJson(spawnUrl, {
    coderPaneId,
    cwd: projectPath,
    projectPath,
    phases,
    persona: "sidecar",
  });

  return {
    sidecarPaneId: response.sidecarPaneId ?? response.paneId,
    coderPaneId,
  };
}

module.exports = {
  MCP_TOOL_DEFINITION,
  spawnSidecar,
};

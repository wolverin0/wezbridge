const assert = require("assert/strict");
const http = require("http");
const test = require("node:test");

const { spawnSidecar } = require("../src/sidecar-spawner.cjs");
const {
  buildBriefingUpdate,
  detectPhaseTransition,
} = require("../src/sidecar-watcher.cjs");

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

test("spawnSidecar skips when phases length is below four", async () => {
  const result = await spawnSidecar({
    coderPaneId: 12,
    projectPath: "G:/project",
    phases: ["one", "two", "three"],
    dashboardBaseUrl: "http://127.0.0.1:1",
  });

  assert.deepEqual(result, { skipped: true });
});

test("spawnSidecar posts to /api/spawn when phases length is four or greater", async (t) => {
  let requestBody = "";
  let requestPath = "";

  const server = http.createServer((request, response) => {
    requestPath = request.url;
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      requestBody += chunk;
    });
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ paneId: 44 }));
    });
  });

  t.after(() => {
    server.close();
  });

  const baseUrl = await listen(server);
  const result = await spawnSidecar({
    coderPaneId: 12,
    projectPath: "G:/project",
    phases: ["one", "two", "three", "four"],
    dashboardBaseUrl: baseUrl,
  });

  assert.equal(requestPath, "/api/spawn");
  assert.equal(result.sidecarPaneId, 44);
  assert.equal(result.coderPaneId, 12);
  assert.equal(JSON.parse(requestBody).persona, "sidecar");
});

test("detectPhaseTransition parses phase markers from scrollback", () => {
  const scrollback = [
    "working through phase 1",
    "Phase 2: add watcher",
    "BEGIN PHASE 3",
  ].join("\n");

  assert.equal(detectPhaseTransition(scrollback, 1), 3);
  assert.equal(detectPhaseTransition(scrollback, 3), null);
});

test("buildBriefingUpdate formats A2A envelope", () => {
  const envelope = buildBriefingUpdate({
    fromPaneId: 7,
    toPaneId: 9,
    corrId: "abc-123",
    body: "Phase 2 audit complete.",
  });

  assert.equal(
    envelope,
    [
      "[A2A from pane-7 to pane-9 | corr=abc-123 | type=progress]",
      "BRIEFING UPDATE",
      "Phase 2 audit complete.",
    ].join("\n")
  );
});

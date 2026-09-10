import { createServer, type Server } from "node:http";
import { execFileSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createReviewerBridgeOptions } from "../sessiond/reviewerBridgeConfig.js";
import { ExecFileHarnessReviewerBridge } from "./harnessReviewerBridge.js";
import { PiSessionService } from "./piSessionService.js";
import { CapturingSessionEventHub, emptyArchiveStore, sessionGateway, testModelRuntime } from "./piSessionService.testSupport.js";
import { createSubsessionToolDefinitions, type SubsessionToolDeps } from "./spawnSubsessionTool.js";

const PI_WEB_ROOT = resolve(process.cwd());
const PI_WEB_PACKAGE = join(resolve(process.execPath, "../.."), "lib/node_modules/@jmfederico/pi-web/package.json");
const HARNESS_ROOT = "/mnt/drive3/Claude-Workspace/repos/ai-engineering-harness-build0148-pi-web-reviewer";
const BRIDGE_FIXTURE = join(HARNESS_ROOT, "tests/support/pi_web_bridge_fixture_entrypoint.py");

function startFakeModelServer(delayMs = 0, content = "INTEGRATION REVIEW: verdict=approved; findings=none"): Promise<{ server: Server; port: number }> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!isStreamBody(parsed)) {
        response.destroy(new Error("invalid fake model request"));
        return;
      }
      const body: { stream?: boolean } = parsed;
      const payload = body.stream === true
        ? `data: ${JSON.stringify({ choices: [{ delta: { role: "assistant", content }, finish_reason: null }] })}\n\ndata: [DONE]\n\n`
        : JSON.stringify({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] });
      const send = () => {
        if (response.destroyed) return;
        response.writeHead(200, { "Content-Type": body.stream === true ? "text/event-stream" : "application/json" });
        response.end(payload);
      };
      if (delayMs > 0) setTimeout(send, delayMs);
      else send();
    });
  });
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("fake model server did not expose a TCP port"));
        return;
      }
      resolvePromise({ server, port: address.port });
    });
  });
}

function isStreamBody(value: unknown): value is { stream?: boolean } {
  return value !== null && typeof value === "object" && !Array.isArray(value) && "stream" in value && (value.stream === undefined || typeof value.stream === "boolean");
}

function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolvePromise) => server.close(() => { resolvePromise(); }));
}

function reviewerBridgeOptions(ledgerRoot: string, upstreamPort: number, timeoutMs = 120_000) {
  return createReviewerBridgeOptions({
    ...process.env,
    PI_WEB_REVIEWER_HARNESS_ROOT: HARNESS_ROOT,
    PI_WEB_REVIEWER_REPOSITORY_ROOT: HARNESS_ROOT,
    PI_WEB_REVIEWER_LEDGER_ROOT: ledgerRoot,
    PI_WEB_REVIEWER_PI_WEB_PACKAGE_JSON: PI_WEB_PACKAGE,
    PI_WEB_REVIEWER_BRIDGE_COMMAND: "/usr/bin/python3",
    PI_WEB_REVIEWER_BRIDGE_ARGS: JSON.stringify([BRIDGE_FIXTURE]),
    PI_WEB_REVIEWER_NODE_BINARY: process.execPath,
    PI_WEB_REVIEWER_BWRAP: "/usr/bin/bwrap",
    PI_WEB_REVIEWER_SOURCE_BIN_DIR: join(homedir(), ".pi/agent/bin"),
    PI_WEB_REVIEWER_UPSTREAM_PORT: String(upstreamPort),
    PI_WEB_REVIEWER_BRIDGE_TIMEOUT_MS: String(timeoutMs),
  }, PI_WEB_ROOT);
}

function toolFor(service: PiSessionService) {
  const deps: SubsessionToolDeps = {
    spawn: (input) => service.spawnSubsession(input),
    list: () => Promise.resolve([]),
    check: () => Promise.resolve({ sessionId: "unused", cwd: "/workspace", status: "unknown" as const, finalText: "", messageCount: 0 }),
    read: () => Promise.resolve({ sessionId: "unused", cwd: "/workspace", status: "unknown" as const, entries: [], total: 0, matched: 0, start: 0, hasMore: false }),
  };
  const tool = createSubsessionToolDefinitions("/workspace", deps).find((item) => item.name === "spawn_subsession");
  if (tool === undefined) throw new Error("spawn_subsession tool missing");
  return tool;
}

function context(): ExtensionContext {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- minimal integration boundary for a Pi tool definition.
  return {
    sessionManager: { getSessionId: () => "integration-parent", getSessionFile: () => undefined },
    model: { provider: "fixture", id: "fixture" },
  } as unknown as ExtensionContext;
}

function textContent(value: unknown): string {
  if (value === null || typeof value !== "object" || !("type" in value) || value.type !== "text" || !("text" in value) || typeof value.text !== "string") throw new Error("expected text tool content");
  return value.text;
}

function reviewContentOf(details: unknown): string {
  if (
    details === null ||
    typeof details !== "object" ||
    !("result" in details) ||
    details.result === null ||
    typeof details.result !== "object" ||
    !("findings" in details.result) ||
    !Array.isArray(details.result.findings) ||
    typeof details.result.findings[0] !== "string"
  ) {
    throw new Error("expected details.result.findings to contain a string");
  }
  return details.result.findings[0];
}

function hasReviewerTransportOrphans(): boolean {
  const sockets = execFileSync("ss", ["-xlpn"], { encoding: "utf8" });
  const processes = execFileSync("ps", ["-eo", "args="], { encoding: "utf8" });
  return sockets.includes("piw-reviewer-") || processes.includes("model_loopback_proxy.mjs");
}

async function waitForNoReviewerTransportOrphans(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!hasReviewerTransportOrphans()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error("reviewer bridge left a proxy process or socket listener behind");
}

describe("real harness reviewer bridge transport", () => {
  it("launches the real Python bridge through ExecFile with real args/env and returns review content", async () => {
    const { server, port } = await startFakeModelServer();
    const ledgerRoot = mkdtempSync(join(tmpdir(), "pi-web-bridge-ledger-"));
    const options = reviewerBridgeOptions(ledgerRoot, port);
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: join(ledgerRoot, "agent"),
      modelRuntime: testModelRuntime,
      sessionManager: sessionGateway([]),
      archiveStore: emptyArchiveStore(),
      spawnTargets: { resolveSpawnTarget: () => Promise.resolve({ allowed: true, cwd: "/workspace" }) },
      reviewerBridge: new ExecFileHarnessReviewerBridge(options),
      heartbeatIntervalMs: 60_000,
    });
    try {
      const result = await toolFor(service).execute("integration-call", { prompt: "review the fixture", logicalRole: "reviewer" }, undefined, undefined, context());
      expect(result.terminate).toBe(true);
      expect(result.details).toMatchObject({
        terminal: true,
        terminate: true,
        result: { terminal_outcome: "succeeded", findings: ["INTEGRATION REVIEW: verdict=approved; findings=none"] },
      });
      expect(result.content[0]).toMatchObject({ type: "text" });
      expect(textContent(result.content[0])).toContain("INTEGRATION REVIEW: verdict=approved; findings=none");
      await waitForNoReviewerTransportOrphans();
    } finally {
      await service.dispose();
      await closeServer(server);
      rmSync(ledgerRoot, { recursive: true, force: true });
    }
  }, 180_000);

  it("turns a real ENOENT bridge spawn into one terminal top-level result", async () => {
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: "/tmp/pi-web-bridge-unavailable-agent",
      modelRuntime: testModelRuntime,
      sessionManager: sessionGateway([]),
      archiveStore: emptyArchiveStore(),
      spawnTargets: { resolveSpawnTarget: () => Promise.resolve({ allowed: true, cwd: "/workspace" }) },
      reviewerBridge: new ExecFileHarnessReviewerBridge({ command: "/definitely/missing/pi-web-reviewer-bridge", timeoutMs: 2_000 }),
      heartbeatIntervalMs: 60_000,
    });
    try {
      const result = await toolFor(service).execute("enoent-call", { prompt: "review", logicalRole: "reviewer" }, undefined, undefined, context());
      expect(result.terminate).toBe(true);
      expect(result.details).toMatchObject({
        terminal: true,
        terminate: true,
        result: { verdict: "review_denied", terminal_outcome: "denied", findings: [], model: "unavailable" },
      });
      expect(textContent(result.content[0])).toContain("Do not retry this request.");
      expect(textContent(result.content[0])).not.toContain("ENOENT");
    } finally {
      await service.dispose();
    }
  });

  it("keeps adversarial sentinels out of the real bridge, tool content, and details", async () => {
    const secret = "SYNTH_REAL_BRIDGE_ESCAPED_JSON";
    const { server, port } = await startFakeModelServer(
      0,
      '{\\"Authorization\\":\\"Bearer SYNTH_REAL_BRIDGE_ESCAPED_JSON\\"}\nAuthoriz' +
      'ation: Bearer SYNTH_REAL_BRIDGE_LABEL_SPLIT\nAuthorization: SYNTH_REAL_BRIDGE_BARE',
    );
    const ledgerRoot = mkdtempSync(join(tmpdir(), "pi-web-bridge-redaction-"));
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: join(ledgerRoot, "agent"),
      modelRuntime: testModelRuntime,
      sessionManager: sessionGateway([]),
      archiveStore: emptyArchiveStore(),
      spawnTargets: { resolveSpawnTarget: () => Promise.resolve({ allowed: true, cwd: "/workspace" }) },
      reviewerBridge: new ExecFileHarnessReviewerBridge(reviewerBridgeOptions(ledgerRoot, port)),
      heartbeatIntervalMs: 60_000,
    });
    try {
      const result = await toolFor(service).execute("redaction-call", { prompt: "review the adversarial fixture", logicalRole: "reviewer" }, undefined, undefined, context());
      const serialized = JSON.stringify(result);

      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain("SYNTH_REAL_BRIDGE_");
      expect(serialized).toContain("<redacted>");
      expect(reviewContentOf(result.details)).toContain("<redacted>");
      expect(reviewContentOf(result.details)).not.toContain(secret);
      expect(textContent(result.content[0])).toContain("<redacted>");
    } finally {
      await service.dispose();
      await closeServer(server);
      rmSync(ledgerRoot, { recursive: true, force: true });
    }
  }, 180_000);

  it("forwards parent cancellation and leaves no real proxy/socket orphan", async () => {
    const { server, port } = await startFakeModelServer(5_000);
    const ledgerRoot = mkdtempSync(join(tmpdir(), "pi-web-bridge-cancel-"));
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: join(ledgerRoot, "agent"),
      modelRuntime: testModelRuntime,
      sessionManager: sessionGateway([]),
      archiveStore: emptyArchiveStore(),
      spawnTargets: { resolveSpawnTarget: () => Promise.resolve({ allowed: true, cwd: "/workspace" }) },
      reviewerBridge: new ExecFileHarnessReviewerBridge(reviewerBridgeOptions(ledgerRoot, port, 15_000)),
      heartbeatIntervalMs: 60_000,
    });
    try {
      const controller = new AbortController();
      const pending = toolFor(service).execute("cancel-call", { prompt: "review slowly", logicalRole: "reviewer" }, controller.signal, undefined, context());
      setTimeout(() => { controller.abort(); }, 500);
      const result = await pending;
      expect(result.terminate).toBe(true);
      expect(result.details).toMatchObject({ result: { verdict: "review_denied", terminal_outcome: "denied" } });
      await waitForNoReviewerTransportOrphans();
    } finally {
      await service.dispose();
      await closeServer(server);
      rmSync(ledgerRoot, { recursive: true, force: true });
    }
  }, 90_000);

  it("forwards the bridge timeout to Python and leaves no real proxy/socket orphan", async () => {
    const { server, port } = await startFakeModelServer(5_000);
    const ledgerRoot = mkdtempSync(join(tmpdir(), "pi-web-bridge-timeout-"));
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: join(ledgerRoot, "agent"),
      modelRuntime: testModelRuntime,
      sessionManager: sessionGateway([]),
      archiveStore: emptyArchiveStore(),
      spawnTargets: { resolveSpawnTarget: () => Promise.resolve({ allowed: true, cwd: "/workspace" }) },
      reviewerBridge: new ExecFileHarnessReviewerBridge(reviewerBridgeOptions(ledgerRoot, port, 500)),
      heartbeatIntervalMs: 60_000,
    });
    try {
      const result = await toolFor(service).execute("timeout-call", { prompt: "review with a short bridge deadline", logicalRole: "reviewer" }, undefined, undefined, context());
      expect(result.terminate).toBe(true);
      expect(result.details).toMatchObject({ result: { verdict: "review_denied", terminal_outcome: "denied" } });
      await waitForNoReviewerTransportOrphans();
    } finally {
      await service.dispose();
      await closeServer(server);
      rmSync(ledgerRoot, { recursive: true, force: true });
    }
  }, 90_000);
});

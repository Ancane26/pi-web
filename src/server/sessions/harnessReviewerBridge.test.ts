import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { ExecFileHarnessReviewerBridge } from "./harnessReviewerBridge.js";
import { PiSessionService } from "./piSessionService.js";
import { CapturingSessionEventHub, emptyArchiveStore, sessionGateway, testModelRuntime } from "./piSessionService.testSupport.js";
import { createSubsessionToolDefinitions, type SubsessionToolDeps } from "./spawnSubsessionTool.js";

const dispatchModel = { provider: "anthropic", id: "claude-sonnet" };

function context(): ExtensionContext {
  const sessionManager = { getSessionId: () => "parent-1", getSessionFile: () => "/sessions/parent-1.jsonl" };
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- minimal tool context test double
  return { sessionManager, model: dispatchModel } as unknown as ExtensionContext;
}

function textContent(value: unknown): string {
  if (value === null || typeof value !== "object" || !("type" in value) || value.type !== "text" || !("text" in value) || typeof value.text !== "string") throw new Error("expected text tool content");
  return value.text;
}

function definitions(spawn: SubsessionToolDeps["spawn"]): ReturnType<typeof createSubsessionToolDefinitions> {
  const deps: SubsessionToolDeps = {
    spawn,
    list: vi.fn(() => Promise.resolve([])),
    check: vi.fn(() => Promise.resolve({ sessionId: "child", cwd: "/workspace", status: "idle" as const, finalText: "", messageCount: 0 })),
    read: vi.fn(() => Promise.resolve({ sessionId: "child", cwd: "/workspace", status: "idle" as const, entries: [], total: 0, matched: 0, start: 0, hasMore: false })),
  };
  return createSubsessionToolDefinitions("/workspace", deps);
}

function spawnTool(defs: ReturnType<typeof createSubsessionToolDefinitions>) {
  const tool = defs.find((definition) => definition.name === "spawn_subsession");
  if (tool === undefined) throw new Error("spawn_subsession definition missing");
  return tool;
}

describe("harness reviewer bridge boundary", () => {
  it("no logical role preserves legacy subsession shape and skips bridge fields", async () => {
    const spawn = vi.fn(() => Promise.resolve({ sessionId: "child-1", cwd: "/workspace" }));
    const result = await spawnTool(definitions(spawn)).execute("call-1", { prompt: "legacy child" }, undefined, undefined, context());

    expect(spawn).toHaveBeenCalledWith({
      spawningCwd: "/workspace",
      parentSessionId: "parent-1",
      parentSessionFile: "/sessions/parent-1.jsonl",
      prompt: "legacy child",
      model: dispatchModel,
    });
    expect(result.details).toEqual({ sessionId: "child-1", cwd: "/workspace" });
    expect(result.details).not.toHaveProperty("logicalRole");
  });

  it("forwards only the role discriminator and returns one terminal bridge decision", async () => {
    const spawn = vi.fn(() => Promise.resolve({
      cwd: "/workspace",
      terminal: true,
      terminate: true,
      result: {
        schema_version: "2.0",
        terminal_outcome: "denied",
        failure_code: "reviewer_operation_denied",
      },
    }));
    const result = await spawnTool(definitions(spawn)).execute("call-2", { prompt: "review", logicalRole: "reviewer" }, undefined, undefined, context());

    expect(spawn).toHaveBeenCalledWith({
      spawningCwd: "/workspace",
      parentSessionId: "parent-1",
      parentSessionFile: "/sessions/parent-1.jsonl",
      prompt: "review",
      model: dispatchModel,
      logicalRole: "reviewer",
    });
    expect(result.terminate).toBe(true);
    expect(result.details).toMatchObject({ terminal: true, terminate: true, result: { terminal_outcome: "denied" } });
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect(textContent(result.content[0])).toContain("ended terminally");
  });

  it("returns one terminal parent decision for a reviewer denial without a retry/check cycle", async () => {
    const history: string[] = [];
    const reviewerBridge = {
      launch: vi.fn(() => {
        history.push("reviewer-launch");
        return Promise.resolve({
          cwd: "/workspace",
          terminal: true,
          terminate: true,
          result: {
            schema_version: "2.0",
            work_id: "parent-1-reviewer-denied",
            attempt: 1,
            result_id: "parent-1-reviewer-denied",
            terminal_outcome: "denied",
            failure_code: "reviewer_operation_denied",
            result_ref: null,
            partial: false,
            error: null,
          },
        });
      }),
      revalidate: vi.fn(() => Promise.resolve(false)),
    };
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: "/tmp/pi-web-test-agent",
      modelRuntime: testModelRuntime,
      sessionManager: sessionGateway([]),
      archiveStore: emptyArchiveStore(),
      spawnTargets: { resolveSpawnTarget: () => Promise.resolve({ allowed: true, cwd: "/workspace" }) },
      reviewerBridge,
      heartbeatIntervalMs: 60_000,
    });

    const result = await service.spawnSubsession({
      spawningCwd: "/workspace",
      parentSessionId: "parent-1",
      parentSessionFile: "/sessions/parent-1.jsonl",
      prompt: "attempt forbidden mutation",
      logicalRole: "reviewer",
    });
    if (result.terminal === true) history.push("terminal-decision");

    expect(history).toEqual(["reviewer-launch", "terminal-decision"]);
    expect(reviewerBridge.launch).toHaveBeenCalledTimes(1);
    expect(reviewerBridge.revalidate).not.toHaveBeenCalled();
    expect(result).toMatchObject({ terminal: true, terminate: true, cwd: "/workspace" });
    await service.dispose();
  });

  it("uses a server-owned argument-array bridge and validates its terminal response", async () => {
    const bridge = new ExecFileHarnessReviewerBridge({ command: "/bin/echo", args: [JSON.stringify({ cwd: "/workspace", terminal: true, terminate: false })] });
    await expect(bridge.launch({ parentSessionId: "parent-1", parentSessionFile: "/sessions/parent-1.jsonl", prompt: "review" })).resolves.toMatchObject({
      cwd: "/workspace",
      terminal: true,
      terminate: false,
    });
  });

  it("does not expose rejected-child stderr diagnostics", async () => {
    const secret = "SYNTH_TRANSPORT_FAILURE_SECRET";
    const bridge = new ExecFileHarnessReviewerBridge({
      command: "/bin/sh",
      args: ["-c", `printf '%s' 'Authorization: Bearer ${secret}' >&2; exit 7`],
    });

    const failure = await bridge.launch({ parentSessionId: "parent-1", parentSessionFile: "/sessions/parent-1.jsonl", prompt: "review" }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) throw new Error("expected bridge launch to fail");
    expect(failure.message).not.toContain(secret);
    expect(failure.message).toBe("Harness reviewer bridge child exited with status 7");
  });

  it("sanitizes bridge result strings before tool content and details cross into Pi", async () => {
    const secret = "SYNTH_PI_RESULT_SECRET";
    const bridgePayload = JSON.stringify({
      cwd: "/workspace",
      terminal: true,
      terminate: true,
      result: {
        terminal_outcome: "succeeded",
        review_content: `Authorization: Bearer ${secret}`,
      },
    });
    const bridge = new ExecFileHarnessReviewerBridge({
      command: "/bin/sh",
      args: ["-c", "printf '%s\\n' \"$1\"", "bridge", bridgePayload],
    });
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: "/tmp/pi-web-test-agent",
      modelRuntime: testModelRuntime,
      sessionManager: sessionGateway([]),
      archiveStore: emptyArchiveStore(),
      spawnTargets: { resolveSpawnTarget: () => Promise.resolve({ allowed: true, cwd: "/workspace" }) },
      reviewerBridge: bridge,
      heartbeatIntervalMs: 60_000,
    });

    try {
      const result = await spawnTool(definitions((input) => service.spawnSubsession(input))).execute(
        "call-sanitized-result",
        { prompt: "review", logicalRole: "reviewer" },
        undefined,
        undefined,
        context(),
      );
      const serialized = JSON.stringify(result);

      expect(serialized).not.toContain(secret);
      expect(serialized).toContain("Authorization: <redacted>");
      expect(result.details).toMatchObject({ result: { review_content: "Authorization: <redacted>" } });
      expect(textContent(result.content[0])).toContain("Authorization: <redacted>");
    } finally {
      await service.dispose();
    }
  });
});

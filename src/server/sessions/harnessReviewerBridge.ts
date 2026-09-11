import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/** Server-owned facts supplied to the harness bridge. No capability, path,
 * policy, digest, or native-tool field is accepted from the Pi Web tool. */
export interface ReviewerBridgeLaunchInput {
  parentSessionId: string;
  parentSessionFile: string | undefined;
  prompt: string;
  signal?: AbortSignal;
}

export interface ReviewerAuthorityRecord {
  workId: string;
  attempt: number;
  routeDigest: string;
  scopeDigest: string;
  stableWorktreeKey: string;
  physicalWorktree: string;
  providerSessionId: string;
  providerToken: string;
  observedTools: string[];
  terminalResultPointer?: { label: string; digest: string; redacted: true };
}

export type ReviewerToolName = "Read" | "Grep" | "Glob";
export type ReviewerDenialReason = "unlisted_tool_denied" | "outside_worktree_denied" | "user_bash_denied" | "tool_execution_denied";
export type ReviewerSeverity = "critical" | "high" | "medium" | "low" | "info";
export type ReviewerTerminalOutcome = "succeeded" | "denied" | "failed" | "timed_out" | "cancelled" | "lost" | "cleanup_unconfirmed";

export interface ReviewerFinding {
  severity: ReviewerSeverity;
  file: string;
  line: number;
  message: string;
}

export interface ReviewerResult {
  verdict: "review_complete" | "review_denied" | "review_failed";
  findings: ReviewerFinding[];
  terminal_outcome: ReviewerTerminalOutcome;
  observed_tools: ReviewerToolName[];
  denied_operations: { reason: ReviewerDenialReason; tool?: ReviewerToolName }[];
  work_id: string;
  model: string;
}

export interface ReviewerBridgeLaunchResult {
  sessionId?: string;
  cwd: string;
  model?: string;
  terminal: boolean;
  terminate: boolean;
  reviewerAuthority?: ReviewerAuthorityRecord;
  result?: ReviewerResult;
}

export interface HarnessReviewerBridge {
  launch(input: ReviewerBridgeLaunchInput): Promise<ReviewerBridgeLaunchResult>;
  revalidate(authority: ReviewerAuthorityRecord): Promise<boolean>;
}

export interface HarnessReviewerBridgeOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const ABORT_GRACE_MS = 20 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isReviewerBridgeLaunchResult(value: unknown): value is ReviewerBridgeLaunchResult {
  if (!isRecord(value)) return false;
  const { cwd, terminal, terminate } = value;
  return typeof cwd === "string" && typeof terminal === "boolean" && typeof terminate === "boolean";
}

function isReviewerResult(value: unknown): value is ReviewerResult {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== ["denied_operations", "findings", "model", "observed_tools", "terminal_outcome", "verdict", "work_id"].join(",")) return false;
  if (value["verdict"] !== "review_complete" && value["verdict"] !== "review_denied" && value["verdict"] !== "review_failed") return false;
  if (!Array.isArray(value["findings"]) || value["findings"].length > 50 || value["findings"].some((item) => {
    if (!isRecord(item) || Object.keys(item).sort().join(",") !== "file,line,message,severity") return true;
    return (item["severity"] !== "critical" && item["severity"] !== "high" && item["severity"] !== "medium" && item["severity"] !== "low" && item["severity"] !== "info")
      || typeof item["file"] !== "string" || item["file"].trim() === "" || item["file"].startsWith("/") || item["file"].includes("\\") || item["file"].split("/").includes("..")
      || typeof item["line"] !== "number" || !Number.isSafeInteger(item["line"]) || item["line"] < 1 || item["line"] > 1_000_000
      || typeof item["message"] !== "string" || item["message"].trim() === "" || item["message"].length > 2_000;
  })) return false;
  if (value["terminal_outcome"] !== "succeeded" && value["terminal_outcome"] !== "denied" && value["terminal_outcome"] !== "failed" && value["terminal_outcome"] !== "timed_out" && value["terminal_outcome"] !== "cancelled" && value["terminal_outcome"] !== "lost" && value["terminal_outcome"] !== "cleanup_unconfirmed") return false;
  if (typeof value["work_id"] !== "string" || typeof value["model"] !== "string") return false;
  const tools = value["observed_tools"];
  if (!Array.isArray(tools) || tools.some((tool) => tool !== "Read" && tool !== "Grep" && tool !== "Glob")) return false;
  const denials = value["denied_operations"];
  if (!Array.isArray(denials)) return false;
  return denials.every((item) => {
    if (!isRecord(item) || Object.keys(item).some((key) => key !== "reason" && key !== "tool") || (item["reason"] !== "unlisted_tool_denied" && item["reason"] !== "outside_worktree_denied" && item["reason"] !== "user_bash_denied" && item["reason"] !== "tool_execution_denied")) return false;
    return item["tool"] === undefined || item["tool"] === "Read" || item["tool"] === "Grep" || item["tool"] === "Glob";
  });
}

function signalChildGroup(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    // The bridge is detached so its pid is also the process-group id. This
    // reaches the Python bridge and any helper it has not yet reaped.
    process.kill(-child.pid, signal);
  } catch (error) {
    const code = isRecord(error) ? error["code"] : undefined;
    if (code !== "ESRCH") child.kill(signal);
  }
}

function checkedResult(value: unknown): ReviewerBridgeLaunchResult {
  if (!isRecord(value)) {
    throw new Error("Harness reviewer bridge returned a non-object result");
  }
  const result = value;
  const unknownKeys = Object.keys(result).filter((key) => !["sessionId", "cwd", "model", "terminal", "terminate", "reviewerAuthority", "result"].includes(key));
  if (unknownKeys.length > 0) throw new Error(`Harness reviewer bridge returned an unrecognized top-level field: ${unknownKeys.join(",")}`);
  if (typeof result["cwd"] !== "string" || typeof result["terminal"] !== "boolean" || typeof result["terminate"] !== "boolean") {
    throw new Error("Harness reviewer bridge result omitted terminal authority fields");
  }
  if (result["result"] !== undefined && !isReviewerResult(result["result"])) {
    throw new Error("Harness reviewer bridge returned a malformed allowlisted reviewer result");
  }
  if (!isReviewerBridgeLaunchResult(result)) {
    throw new Error("Harness reviewer bridge result omitted terminal authority fields");
  }
  // Defense in depth only: Python is the canonical findings sanitizer. This
  // assertion is deliberately a single narrow bearer-shaped backstop, not a
  // second recursive sanitizer implementation.
  if (result.result?.findings.some((finding) => /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i.test(finding.message)) === true) {
    throw new Error("Harness reviewer bridge returned an unsafe findings value");
  }
  const checked: ReviewerBridgeLaunchResult = {
    cwd: result.cwd,
    terminal: result.terminal,
    terminate: result.terminate,
  };
  if (result.sessionId !== undefined) {
    if (typeof result.sessionId !== "string") throw new Error("Harness reviewer bridge sessionId must be a string");
    checked.sessionId = result.sessionId;
  }
  if (result.model !== undefined) {
    if (typeof result.model !== "string") throw new Error("Harness reviewer bridge model must be a string");
    checked.model = result.model;
  }
  if (result.reviewerAuthority !== undefined) checked.reviewerAuthority = result.reviewerAuthority;
  if (result.result !== undefined) checked.result = result.result;
  return checked;
}

/**
 * Small argument-array-only child-process transport. The harness command is
 * configured by the server owner; the Pi Web caller can provide only the
 * parent identity and prompt above.
 */
export class ExecFileHarnessReviewerBridge implements HarnessReviewerBridge {
  constructor(private readonly options: HarnessReviewerBridgeOptions) {
    if (options.command.trim() === "") throw new Error("Harness bridge command is required");
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
      throw new Error("Harness bridge timeout must be a positive finite number");
    }
  }

  launch(input: ReviewerBridgeLaunchInput): Promise<ReviewerBridgeLaunchResult> {
    return this.invoke(
      { operation: "launch", parentSessionId: input.parentSessionId, parentSessionFile: input.parentSessionFile, prompt: input.prompt },
      input.signal,
    );
  }

  revalidate(authority: ReviewerAuthorityRecord): Promise<boolean> {
    return this.invoke({ operation: "revalidate", reviewerAuthority: authority }).then((result) => result.terminal && !result.terminate);
  }

  private invoke(payload: Record<string, unknown>, signal?: AbortSignal): Promise<ReviewerBridgeLaunchResult> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(new Error("Harness reviewer bridge invocation was aborted"));
        return;
      }
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(this.options.command, [...(this.options.args ?? [])], {
          cwd: this.options.cwd,
          env: this.options.env,
          shell: false,
          detached: true,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch {
        reject(new Error("Harness reviewer bridge child failed to start"));
        return;
      }
      let stdout = "";
      let settled = false;
      let killHandle: NodeJS.Timeout | undefined;
      const cleanupListeners = () => {
        clearTimeout(timeoutHandle);
        if (signal !== undefined) signal.removeEventListener("abort", onAbort);
      };
      const finish = (error: Error | undefined, result?: ReviewerBridgeLaunchResult) => {
        if (settled) return;
        settled = true;
        cleanupListeners();
        if (error === undefined && result !== undefined) resolve(result);
        else reject(error ?? new Error("Harness reviewer bridge did not return a result"));
      };
      const terminate = (reason: Error) => {
        signalChildGroup(child, "SIGTERM");
        killHandle = setTimeout(() => { signalChildGroup(child, "SIGKILL"); }, ABORT_GRACE_MS);
        killHandle.unref();
        finish(reason);
      };
      const onAbort = () => { terminate(new Error("Harness reviewer bridge invocation was aborted")); };
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { stdout = `${stdout}${chunk}`.slice(-64 * 1024); });
      child.once("error", () => { finish(new Error("Harness reviewer bridge child failed")); });
      // A short-lived bridge command may close stdin before the payload write
      // completes. Its stdout/exit result is still authoritative; avoid an
      // unhandled EPIPE from the best-effort request submission in that case.
      child.stdin.once("error", () => undefined);
      child.once("close", (code, signal) => {
        if (settled) {
          if (killHandle !== undefined) clearTimeout(killHandle);
          return;
        }
        if (code !== 0) {
          finish(new Error(`Harness reviewer bridge child exited with status ${String(code)}${signal === null ? "" : ` via ${signal}`}`));
          return;
        }
        try {
          finish(undefined, checkedResult(JSON.parse(stdout)));
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      });
      if (signal !== undefined) signal.addEventListener("abort", onAbort, { once: true });
      const timeoutHandle = setTimeout(() => { terminate(new Error("Harness reviewer bridge invocation timed out")); }, this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      child.stdin.end(`${JSON.stringify(payload)}\n`);
    });
  }
}

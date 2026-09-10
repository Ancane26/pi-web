import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { sanitizeReviewerBridgePayload } from "./reviewerBridgeRedaction.js";

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

export interface ReviewerBridgeLaunchResult {
  sessionId?: string;
  cwd: string;
  model?: string;
  terminal: boolean;
  terminate: boolean;
  reviewerAuthority?: ReviewerAuthorityRecord;
  result?: Record<string, unknown>;
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
  if (typeof result["cwd"] !== "string" || typeof result["terminal"] !== "boolean" || typeof result["terminate"] !== "boolean") {
    throw new Error("Harness reviewer bridge result omitted terminal authority fields");
  }
  const sanitized = sanitizeReviewerBridgePayload(result);
  if (!isReviewerBridgeLaunchResult(sanitized)) {
    throw new Error("Harness reviewer bridge result omitted terminal authority fields");
  }
  return sanitized;
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

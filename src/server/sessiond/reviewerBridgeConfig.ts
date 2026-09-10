import { join, resolve } from "node:path";
import type { HarnessReviewerBridgeOptions } from "../sessions/harnessReviewerBridge.js";

/**
 * The server owns these defaults. They are deliberately concrete so a source
 * checkout can launch the bridge without requiring a PATH-installed command or
 * undocumented deployment-side variables. Operators may replace them with
 * equally server-owned values through the daemon environment.
 */
export const DEFAULT_REVIEWER_HARNESS_ROOT = "/mnt/drive3/Claude-Workspace/repos/ai-engineering-harness-build0148-pi-web-reviewer";
const DEFAULT_PYTHON = "/usr/bin/python3";
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

function defaultPiWebPackageJson(): string {
  const nodePrefix = resolve(process.execPath, "../..");
  return join(nodePrefix, "lib/node_modules/@jmfederico/pi-web/package.json");
}

function stringEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

function argsEnv(env: NodeJS.ProcessEnv, bridgeScript: string): string[] {
  const configured = stringEnv(env, "PI_WEB_REVIEWER_BRIDGE_ARGS");
  if (configured === undefined) return [bridgeScript];
  let parsed: unknown;
  try {
    parsed = JSON.parse(configured);
  } catch (error) {
    throw new Error(`PI_WEB_REVIEWER_BRIDGE_ARGS must be a JSON string array: ${String(error)}`, { cause: error });
  }
  if (!Array.isArray(parsed) || !parsed.every((item): item is string => typeof item === "string")) {
    throw new Error("PI_WEB_REVIEWER_BRIDGE_ARGS must be a JSON string array");
  }
  return parsed;
}

function timeoutEnv(env: NodeJS.ProcessEnv): number {
  const configured = stringEnv(env, "PI_WEB_REVIEWER_BRIDGE_TIMEOUT_MS");
  if (configured === undefined) return DEFAULT_TIMEOUT_MS;
  const timeout = Number(configured);
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("PI_WEB_REVIEWER_BRIDGE_TIMEOUT_MS must be positive");
  return timeout;
}

export function createReviewerBridgeOptions(
  env: NodeJS.ProcessEnv,
  cwd: string,
): HarnessReviewerBridgeOptions {
  void cwd;
  const harnessRoot = resolve(stringEnv(env, "PI_WEB_REVIEWER_HARNESS_ROOT") ?? DEFAULT_REVIEWER_HARNESS_ROOT);
  const bridgeScript = join(harnessRoot, "runtimes/pi_web/reviewer_bridge.py");
  const repositoryRoot = resolve(stringEnv(env, "PI_WEB_REVIEWER_REPOSITORY_ROOT") ?? harnessRoot);
  const ledgerRoot = resolve(stringEnv(env, "PI_WEB_REVIEWER_LEDGER_ROOT") ?? join(harnessRoot, ".pi-web-reviewer-ledger"));
  const packageJson = resolve(stringEnv(env, "PI_WEB_REVIEWER_PI_WEB_PACKAGE_JSON") ?? defaultPiWebPackageJson());
  const bridgeEnv: NodeJS.ProcessEnv = {
    ...env,
    PI_WEB_REVIEWER_REPOSITORY_ROOT: repositoryRoot,
    PI_WEB_REVIEWER_LEDGER_ROOT: ledgerRoot,
    PI_WEB_REVIEWER_PI_WEB_PACKAGE_JSON: packageJson,
  };
  return {
    command: stringEnv(env, "PI_WEB_REVIEWER_BRIDGE_COMMAND") ?? DEFAULT_PYTHON,
    args: argsEnv(env, bridgeScript),
    cwd: resolve(stringEnv(env, "PI_WEB_REVIEWER_BRIDGE_CWD") ?? harnessRoot),
    env: bridgeEnv,
    timeoutMs: timeoutEnv(env),
  };
}

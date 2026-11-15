import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createReviewerBridgeOptions, DEFAULT_REVIEWER_HARNESS_ROOT } from "./reviewerBridgeConfig.js";

describe("sessiond reviewer bridge assembly", () => {
  it("assembles a real Python command, args, and server-owned bridge environment", () => {
    const options = createReviewerBridgeOptions({}, "/srv/pi-web");

    expect(options.command).toBe("/usr/bin/python3");
    expect(options.args).toEqual([join(DEFAULT_REVIEWER_HARNESS_ROOT, "runtimes/pi_web/reviewer_bridge.py")]);
    expect(options.env).toMatchObject({
      PI_WEB_REVIEWER_REPOSITORY_ROOT: DEFAULT_REVIEWER_HARNESS_ROOT,
      PI_WEB_REVIEWER_LEDGER_ROOT: join(DEFAULT_REVIEWER_HARNESS_ROOT, ".pi-web-reviewer-ledger"),
      PI_WEB_REVIEWER_PI_WEB_PACKAGE_JSON: join(resolve(process.execPath, "../.."), "lib/node_modules/@jmfederico/pi-web/package.json"),
    });
  });

  it("accepts an operator-owned executable and JSON argument array without shell parsing", () => {
    const options = createReviewerBridgeOptions({
      PI_WEB_REVIEWER_HARNESS_ROOT: "/srv/harness",
      PI_WEB_REVIEWER_BRIDGE_COMMAND: "/usr/bin/python3",
      PI_WEB_REVIEWER_BRIDGE_ARGS: '["/srv/harness/runtimes/pi_web/reviewer_bridge.py"]',
      PI_WEB_REVIEWER_REPOSITORY_ROOT: "/srv/harness",
      PI_WEB_REVIEWER_LEDGER_ROOT: "/srv/ledger",
      PI_WEB_REVIEWER_PI_WEB_PACKAGE_JSON: "/srv/pi-web/package.json",
    }, "/ignored");

    expect(options.command).toBe("/usr/bin/python3");
    expect(options.args).toEqual(["/srv/harness/runtimes/pi_web/reviewer_bridge.py"]);
    expect(options.env).toMatchObject({
      PI_WEB_REVIEWER_REPOSITORY_ROOT: "/srv/harness",
      PI_WEB_REVIEWER_LEDGER_ROOT: "/srv/ledger",
      PI_WEB_REVIEWER_PI_WEB_PACKAGE_JSON: "/srv/pi-web/package.json",
    });
  });
});

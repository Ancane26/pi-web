import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "pi-web-plugins/**/*.test.ts", "pi-packages/**/*.test.ts", "scripts/**/*.test.mjs"],
    // The reviewer bridge integration tests start bwrap/Python/Node process
    // trees. Serial workers keep those real authority-boundary tests reliable
    // under the repository's existing process-heavy suite.
    maxWorkers: 1,
  },
});

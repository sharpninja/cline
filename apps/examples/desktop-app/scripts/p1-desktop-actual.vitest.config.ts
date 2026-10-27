// SPDX-License-Identifier: Apache-2.0
// Test-only bounded entry point. Does not invoke build:ui or broaden collection.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("../webview", import.meta.url)) } },
  test: {
    include: ["scripts/p1-desktop-actual-composition.test.tsx"],
    setupFiles: ["./scripts/p1-desktop-actual-isolation.setup.fixture.ts"],
    environment: "jsdom",
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});

import { defineConfig } from "vitest/config"
import baseline from "./vitest.config"

export default defineConfig({
  ...baseline,
  test: {
    ...baseline.test,
    setupFiles: [],
    include: ["src/sdk/vscode-receiver-boundary.baseline.test.ts"],
    passWithNoTests: false,
    fileParallelism: false,
    maxWorkers: 1,
  },
})
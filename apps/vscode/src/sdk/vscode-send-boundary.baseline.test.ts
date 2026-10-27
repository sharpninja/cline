// SPDX-License-Identifier: Apache-2.0
// Test-only isolated public method binding. This does not construct a VS Code host,
// execute an SDK/provider, persist audit records or observe the eventual UI receiver.
import { it, vi } from "vitest";
import type { Factory } from "./vscode-send-boundary.contract.test-support";
import { assertSendBoundary, boundaryCases } from "./vscode-send-boundary.contract.test-support";

vi.mock("@cline/core", () => ({ resetModelsFileState: () => {}, ClineCore: { create: () => { throw new Error("unexpected core construction"); } } }));
vi.mock("@cline/llms", () => ({ resetRegistry: () => {} }));
vi.mock("@cline/shared", () => ({ RUNTIME_CONFIG_EXTENSION_KINDS: [] }));
vi.mock("@/core/storage/StateManager", () => ({ StateManager: { get: () => { throw new Error("unexpected state access"); } } }));
vi.mock("@/services/logging/distinctId", () => ({ getDistinctId: () => { throw new Error("unexpected identity access"); } }));
vi.mock("@/shared/services/Logger", () => ({ Logger: { log: () => {}, error: () => {} } }));
vi.mock("./git-telemetry", () => ({ VscodeGitTelemetryManager: class {} }));
vi.mock("./vscode-runtime-builder", () => ({ createVscodeExtraTools: () => { throw new Error("unexpected tool construction"); } }));
vi.mock("./vscode-terminal-execution-mode", () => ({ getEffectiveTerminalExecutionMode: () => { throw new Error("unexpected terminal access"); } }));

// Runtime import is intercepted by the complete boundary stubs above before evaluation.
import { VscodeSessionHost } from "./vscode-session-host";
const baseline: Factory = inner => ({
  send(input) {
    // This is the unchanged public send method with only its existing inner dependency injected.
    // No private field is written on a real host, and no constructor/startup evidence is claimed.
    return VscodeSessionHost.prototype.send.call({ inner } as unknown as VscodeSessionHost, input);
  },
});
for (const scenario of boundaryCases) {
  it(`binds the SAME send boundary assertions to the isolated public method: ${scenario.name}`, async () => {
    const evidence = await assertSendBoundary(scenario, baseline);
    console.log(JSON.stringify({ kind: "actual-public-send-boundary", evidence }));
  });
}


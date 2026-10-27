// SPDX-License-Identifier: Apache-2.0
// Actual isolated public factory only. Scripted manager/SDK surface, no provider or hub.
// SAME frozen contract inputs/assertions. Original sixteen tests remain a separate gate.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { afterAll, it, vi } from "vitest";
import type { Factory, Port, SendInput } from "./interactive-recovery.contract.test-support";
import { assertInteractiveRecovery, scenarios } from "./interactive-recovery.contract.test-support";

const state = vi.hoisted(() => {
 const refs = new WeakMap<object, number>();
 let nextRef = 0;
 const ref = (value: object) => {
  if (!refs.has(value)) refs.set(value, ++nextRef);
  return refs.get(value)!;
 };
 const snapshot = (value: unknown, stack = new WeakSet<object>()): unknown => {
  if (value === undefined) return { kind: "undefined" };
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return value;
  const identity = ref(value);
  if (typeof value === "function") return { kind: "function-reference", identity, name: value.name };
  if (stack.has(value)) return { kind: "cycle-reference", identity };
  stack.add(value);
  let result: unknown;
  if (value instanceof Error) {
   result = { kind: "error-reference", identity, name: value.name, message: value.message,
    ownFields: Object.fromEntries(Object.keys(value).map(key =>
     [key, snapshot((value as unknown as Record<string, unknown>)[key], stack)])),
    stackOmitted: true };
  } else if (Array.isArray(value)) {
   result = { kind: "array-reference", identity, values: value.map(item => snapshot(item, stack)) };
  } else {
   result = { kind: "object-reference", identity, fields: Object.fromEntries(Object.keys(value).map(key =>
    [key, snapshot((value as Record<string, unknown>)[key], stack)])) };
  }
  stack.delete(value);
  return result;
 };
 const calls: unknown[] = [];
 const record = (root: string, method: string, phase: string, value: unknown) =>
  calls.push({ root, method, phase, value: snapshot(value) });
 return {
  routes: new Map<string, { manager: object; port: Port }>(),
  byManager: new WeakMap<object, { root: string; port: Port }>(),
  calls, record, snapshot,
 };
});

vi.mock("@cline/core", async () => await import("./interactive-recovery.actual.test-support"));
vi.mock("../session/session", () => ({
 createCliCore: async (input: { cwd: string }) => {
  state.record(input.cwd, "createCliCore", "call", input);
  const route = state.routes.get(input.cwd);
  if (!route) throw new Error("Unregistered synthetic factory root");
  state.record(input.cwd, "createCliCore", "return", route.manager);
  return route.manager;
 },
}));
vi.mock("../utils/hooks", () => ({
 createRuntimeHooks: (input: { cwd: string }) => {
  state.record(input.cwd, "createRuntimeHooks", "call", input);
  const route = state.routes.get(input.cwd);
  if (!route) throw new Error("Unregistered synthetic hooks root");
  return { hooks: {}, shutdown: async () => {
   state.record(input.cwd, "runtimeHooks.shutdown", "call", []);
   await route.port.shutdownHooks();
   state.record(input.cwd, "runtimeHooks.shutdown", "return", undefined);
  } };
 },
}));
vi.mock("../utils/output", () => ({
 c: { cyan: "", reset: "" },
 formatUsd: () => { throw new Error("Usage formatting is outside this binding"); },
 setActiveCliSession: (value: unknown) => state.record("factory-output-observation", "setActiveCliSession", "call", value),
}));
vi.mock("../utils/usage-cost-display", () => ({
 shouldShowCliUsageCost: () => { throw new Error("Usage formatting is outside this binding"); },
}));
vi.mock("../utils/approval", () => ({
 submitAndExitInTerminal: () => { throw new Error("Terminal approval execution is outside this binding"); },
}));
vi.mock("../runtime/active-runtime", () => ({
 markAbortInProgress: () => state.record("factory-abort-observation", "markAbortInProgress", "call", []),
}));
vi.mock("../runtime/session-events", () => ({
 subscribeToAgentEvents: (manager: object, callback: unknown) => {
  const route = state.byManager.get(manager);
  if (!route) throw new Error("Unregistered synthetic agent subscription");
  state.record(route.root, "subscribeToAgentEvents", "call", callback);
  return () => {
   state.record(route.root, "unsubscribe-agent", "call", []);
   route.port.unsubscribe("agent");
  };
 },
 subscribeToPendingPromptEvents: (manager: object, callbacks: unknown) => {
  const route = state.byManager.get(manager);
  if (!route) throw new Error("Unregistered synthetic pending subscription");
  state.record(route.root, "subscribeToPendingPromptEvents", "call", callbacks);
  return () => {
   state.record(route.root, "unsubscribe-pending", "call", []);
   route.port.unsubscribe("pending");
  };
 },
}));
vi.mock("../runtime/interactive/compaction", () => ({
 compactInteractiveMessages: () => { throw new Error("Compaction algorithm is outside this binding"); },
}));
vi.mock("../runtime/interactive/mode", () => ({
 applyInteractiveModeConfig: () => { throw new Error("Mode algorithm is outside this binding"); },
}));
vi.mock("../runtime/interactive/fork/metadata", () => ({
 buildForkSessionMetadata: () => { throw new Error("Fork algorithm is outside this binding"); },
}));

import { createInteractiveSessionRuntime } from "../runtime/interactive/session-runtime";

const actualFactory: Factory = (options, port) => {
 const root = options.cwd;
 const invoke = async <T>(method: string, args: unknown[], operation: () => Promise<T>): Promise<T> => {
  state.record(root, method, "call", args);
  try {
   const result = await operation();
   state.record(root, method, "return", result);
   return result;
  } catch (error) {
   state.record(root, method, "throw", error);
   throw error;
  }
 };
 const manager = {
  start: (input: { config: { sessionId?: string }; initialMessages?: unknown[] }) =>
   invoke("manager.start", [input], async () => {
    const sessionId = await port.start({ initial: input.initialMessages ?? [],
     ...(input.config.sessionId ? { resumeId: input.config.sessionId } : {}) });
    return { sessionId, manifest: { session_id: sessionId, cwd: root, workspace_root: root,
     source: "cli", provider: "anthropic", model: "synthetic-direct-model" } };
   }),
  send: (input: SendInput) => invoke("manager.send", [input], () => port.send(input)),
  readMessages: (id: string) => invoke("manager.readMessages", [id], () => port.readMessages(id)),
  get: (id: string) => invoke("manager.get", [id], () => port.getRow(id)),
  getAccumulatedUsage: (id: string) => invoke("manager.getAccumulatedUsage", [id], () => port.getUsage(id)),
  abort: (id: string, reason: unknown) => invoke("manager.abort", [id, reason], () => port.abort(id)),
  stop: (id: string) => invoke("manager.stop", [id], () => port.stop(id)),
  dispose: (reason: string) => invoke("manager.dispose", [reason], () => port.dispose(reason)),
 };
 state.routes.set(root, { manager, port });
 state.byManager.set(manager, { root, port });
 const config = {
  providerId: "anthropic", modelId: "synthetic-direct-model", apiKey: "",
  cwd: root, workspaceRoot: root, systemPrompt: "synthetic task-owned prompt",
  mode: "act", enableTools: true, enableSpawnAgent: false, enableAgentTeams: false,
  verbose: false, thinking: false, outputMode: "text", sandbox: false,
  defaultToolAutoApprove: false, toolPolicies: { "*": { autoApprove: false } },
  logger: { log: (...args: unknown[]) => state.record(root, "logger.log", "call", args) },
 };
 const input = {
  config, providerSettingsManager: { getProviderSettings: () => undefined },
  resumeSessionId: options.resumeId,
  chatCommandState: { enableTools: true, autoApproveTools: false, cwd: root, workspaceRoot: root },
  requestToolApproval: async () => { throw new Error("Provider/tool approval is outside this binding"); },
  resolveToolPolicy: () => ({ autoApprove: false }),
  askQuestionRef: { current: null }, resolveMistakeLimitDecision: undefined,
  switchToActModeTool: { name: "synthetic-unused-switch", description: "not executed",
   inputSchema: { type: "object", properties: {} },
   execute: () => { throw new Error("Mode tool is outside this binding"); } },
  onAgentEvent: (...args: unknown[]) => state.record(root, "onAgentEvent", "call", args),
  onTeamEvent: (...args: unknown[]) => state.record(root, "onTeamEvent", "call", args),
  onPendingPrompts: (...args: unknown[]) => state.record(root, "onPendingPrompts", "call", args),
  onPendingPromptSubmitted: (...args: unknown[]) => state.record(root, "onPendingPromptSubmitted", "call", args),
 };
 state.record(root, "createInteractiveSessionRuntime", "call", input);
 const runtime = createInteractiveSessionRuntime(input as unknown as Parameters<typeof createInteractiveSessionRuntime>[0]);
 return {
  ensureReady: () => runtime.ensureReady(),
  sendCurrentTurn: input => runtime.sendCurrentTurn(input as Parameters<typeof runtime.sendCurrentTurn>[0]),
  resetForNewSession: () => runtime.resetForNewSession(),
  abortAll: () => runtime.abortAll(),
  cleanup: () => runtime.cleanup(),
  activeSessionId: () => runtime.getActiveSessionId() || undefined,
 };
};

const histories: unknown[] = [], failures: unknown[] = [];
for (const scenario of scenarios) {
 it("binds SAME interactive recovery contract to public factory: " + scenario.name, async () => {
  state.routes.clear();
  const firstCall = state.calls.length;
  try {
   const result = await assertInteractiveRecovery(scenario, actualFactory);
   histories.push({ ...result, actualFactoryCalls: state.calls.slice(firstCall) });
  } catch (error) {
   failures.push({ name: scenario.name, error: state.snapshot(error),
    interactionEvidence: (error as { interactionEvidence?: unknown })?.interactionEvidence,
    actualFactoryCalls: state.calls.slice(firstCall) });
   throw error;
  }
 });
}
afterAll(() => {
 const path = process.env.QB_C_INTERACTIVE_EVIDENCE_PATH;
 if (path) {
  const runRoot = process.env.QB_C_INTERACTIVE_RUN_ROOT;
  assert.ok(runRoot, "interactive-evidence-task-root-required");
  assert.equal(dirname(resolve(path)), resolve(runRoot), "interactive-evidence-within-task-root");
  assert.equal(resolve(process.env.HOME ?? ""), resolve(runRoot, "home"), "interactive-evidence-synthetic-home");
  assert.equal(resolve(process.env.TMP ?? ""), resolve(runRoot, "temp"), "interactive-evidence-synthetic-temp");
  writeFileSync(path, JSON.stringify({
  kind: "actual-isolated-public-interactive-factory-with-scripted-dependencies",
  required: scenarios.length, histories, failures,
  SDKRuntimeConsumed: false, nativeHost: false, providerExecuted: false,
  actualGovernance: false, durableAuditProductProof: false, scopeAccepted: false,
  snapshotFormat: "Object/function/error reference IDs and exact enumerable fields. Error stacks intentionally omitted. In-memory SAME assertions verify original result/error reference identity.",
 }));
 }
 assert.equal(histories.length + failures.length, scenarios.length, "interactive-binding-all-required-cases-accounted");
});

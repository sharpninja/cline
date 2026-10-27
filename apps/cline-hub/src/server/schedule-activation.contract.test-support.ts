// Test-only contract. No production, SDK, network or provider imports.
import assert from "node:assert/strict";
import {
  independentHostModel,
  type Event, type Fault, type Pair, type Script,
} from "../../../cli/src/qbrain-p1/schedule-admission.model.test-support";

export type Row = Record<string, unknown>;
export interface ActivationInput {
  operation: "resume" | "trigger";
  pair: Pair;
  script: Script;
  enabled: boolean;
  seed: { workspaceRoot: string; cwd: string; prompt: string; metadata: Row };
}
export interface ActivationCase {
  name: string;
  input: ActivationInput;
  admitted: boolean;
  error?: RegExp;
  admissionFault?: Fault;
}
export interface RuntimeResponses {
  start: { sessionId: string; stopBeforeReturn?: boolean };
  send: { result: { text: string; iterations: number }; error?: string };
  stop: { applied: boolean };
}
export interface ActivationCapture {
  outcome: { ok: boolean; pair?: Pair; error?: string };
  before: Row; after: Row; reopened: Row;
  executions: Row[]; reopenedExecutions: Row[]; runtime: Row[];
  commands: Event[]; journal: Event[]; routineReply?: Row; publishedEvents: unknown[][];
  pending?: { row: Row; executions: Row[]; runtime: Row[]; commands: Event[] };
}
export type ExecutionFault = "none" | "enqueue-disabled" | "enable-disabled"
  | "false-execution-ack" | "omit-queue" | "duplicate-queue"
  | "wrong-execution-session" | "wrong-rawreply";
export interface ModelFault { admission?: Fault; execution?: ExecutionFault }
export type ActivationProvider = (input: ActivationInput, responses: RuntimeResponses, fault?: ModelFault) => Promise<ActivationCapture>;
const clone = <T>(value: T): T => structuredClone(value);
const direct: Pair = { providerId: "direct-a", modelId: "model-a" };
const catalogs = [
  { providerId: "direct-a", enabled: true, models: ["model-a"] },
  { providerId: "cline", enabled: true, models: ["synthetic-hosted-old"] },
];
// Expected admission values are requirement-derived data. Providers never receive cases.
export function createActivationCases(root: string): ActivationCase[] {
  const entries = [
    { name: "direct-current", pair: direct, script: { catalogs }, admitted: true },
    { name: "hosted-blocked", pair: { providerId: "cline", modelId: "synthetic-hosted-old" }, script: { catalogs }, admitted: false, error: /direct provider|hosted/, admissionFault: "allow-hosted" },
    { name: "stale-catalog", pair: direct, script: { catalogs: [{ providerId: "direct-a", enabled: true, models: ["different"] }] }, admitted: false, error: /catalog|Settings/, admissionFault: "write-before-catalog" },
    { name: "disabled-catalog", pair: direct, script: { catalogs: [{ providerId: "direct-a", enabled: false, models: ["model-a"] }] }, admitted: false, error: /catalog|Settings/, admissionFault: "ignore-enabled" },
    { name: "failed-catalog", pair: direct, script: { catalogs, error: "synthetic-catalog-failure" }, admitted: false, error: /catalog|Catalog|Settings/, admissionFault: "write-before-catalog" },
    { name: "delayed-valid", pair: direct, script: { catalogs, delayed: true }, admitted: true },
    { name: "delayed-empty", pair: direct, script: { catalogs: [], delayed: true }, admitted: false, error: /catalog|Settings/, admissionFault: "write-while-pending" },
    { name: "incomplete-unit", pair: { providerId: "direct-a", modelId: "" }, script: { catalogs }, admitted: false, error: /Select both|Repair modelSelection/, admissionFault: "first-model" },
  ] satisfies { name: string; pair: Pair; script: Script; admitted: boolean; error?: RegExp; admissionFault?: Fault }[];
  const cases: ActivationCase[] = [];
  for (const group of [
    { operation: "resume", enabled: false, prefix: "resume" },
    { operation: "trigger", enabled: false, prefix: "trigger" },
    { operation: "trigger", enabled: true, prefix: "trigger-enabled" },
  ] as const) {
    for (const entry of entries) {
      cases.push({
        name: group.prefix + ":" + entry.name,
        input: { operation: group.operation, enabled: group.enabled, pair: clone(entry.pair), script: clone(entry.script),
          seed: { workspaceRoot: root, cwd: root, prompt: "Synthetic activation", metadata: { canary: "activation-original" } } },
        admitted: entry.admitted,
        ...("error" in entry ? { error: entry.error } : {}),
        ...("admissionFault" in entry ? { admissionFault: entry.admissionFault } : {}),
      });
    }
  }
  return cases;
}
export function correctRuntimeResponses(): RuntimeResponses {
  return { start: { sessionId: "synthetic-model-session" }, send: { result: { text: "Synthetic activation result", iterations: 1 } }, stop: { applied: true } };
}
export function faultyRuntimeResponses(kind: "empty-session" | "send-error" | "early-stop"): RuntimeResponses {
  const responses = correctRuntimeResponses();
  if (kind === "empty-session") responses.start.sessionId = "";
  if (kind === "send-error") responses.send.error = "synthetic-send-error";
  if (kind === "early-stop") responses.start.stopBeforeReturn = true;
  return responses;
}
// SAME assertions for the independent provider and later real SQLite adapter.
export function assertActivation(scenario: ActivationCase, value: ActivationCapture): void {
  assert.equal(value.outcome.ok, scenario.admitted, "admission outcome");
  assert.equal(value.before.enabled, scenario.input.enabled, "explicit initial enabled state");
  assert.equal(value.before.workspaceRoot, scenario.input.seed.workspaceRoot);
  assert.equal(value.before.cwd, scenario.input.seed.cwd);
  assert.equal(value.before.prompt, scenario.input.seed.prompt);
  assert.deepStrictEqual(value.before.metadata, scenario.input.seed.metadata);
  assert.deepStrictEqual(value.reopened, value.after, "complete independently reopened record");
  assert.deepStrictEqual(value.reopenedExecutions, value.executions, "complete independently reopened history");
  assert.equal(value.commands.length, scenario.admitted ? 1 : 0, "exact admitted command count");
  if (scenario.input.script.delayed) {
    assert.ok(value.pending);
    assert.deepStrictEqual(value.pending.row, value.before);
    assert.equal(value.pending.executions.length, 0);
    assert.equal(value.pending.runtime.length, 0);
    assert.equal(value.pending.commands.length, 0);
  }
  if (!scenario.admitted) {
    assert.match(value.outcome.error ?? "", scenario.error!);
    assert.deepStrictEqual(value.after, value.before);
    assert.equal(value.runtime.length, 0);
    assert.equal(value.executions.length, 0);
    assert.equal(value.publishedEvents.length, 0);
    return;
  }
  assert.deepStrictEqual(value.outcome.pair, direct);
  assert.deepStrictEqual(value.after.modelSelection, direct);
  assert.deepStrictEqual(value.commands[0]!.data, { operation: scenario.input.operation, pair: direct });
  const response = value.journal.findIndex((event) => event.kind === "catalog-response");
  const command = value.journal.findIndex((event) => event.kind === "command");
  assert.ok(response >= 0 && response < command, "catalog completes before actual command");
  const stable = (row: Row) => Object.fromEntries(Object.entries(row).filter(([key]) => !["enabled", "updatedAt", "nextRunAt", "lastRunAt"].includes(key)));
  assert.deepStrictEqual(stable(value.after), stable(value.before), "all identity/selection/canary fields stable");
  if (scenario.input.operation === "resume") {
    assert.equal(value.after.enabled, true);
    assert.equal(value.runtime.length, 0);
    assert.equal(value.executions.length, 0);
    assert.equal(value.publishedEvents.length, 0);
    assert.equal(value.after.lastRunAt, value.before.lastRunAt);
    const reply = value.routineReply?.schedule as Row;
    assert.ok(reply);
    assert.equal(reply.scheduleId, value.before.scheduleId);
    assert.equal(reply.enabled, true);
    assert.deepStrictEqual(reply.modelSelection, direct);
    return;
  }
  assert.equal(value.after.enabled, scenario.input.enabled, "manual trigger never implicitly enables");
  if (!scenario.input.enabled) {
    assert.deepStrictEqual(value.after, value.before, "disabled full record remains unchanged");
    assert.deepStrictEqual(value.routineReply, { execution: null }, "original disabled enqueue reply");
    assert.equal(value.executions.length, 0);
    assert.equal(value.runtime.length, 0);
    assert.equal(value.publishedEvents.length, 0);
    return;
  }
  assert.equal(value.executions.length, 1);
  const execution = value.executions[0]!;
  assert.equal(execution.status, "success", "enabled queued execution succeeds");
  assert.equal(execution.scheduleId, value.before.scheduleId);
  const reply = value.routineReply?.execution as Row;
  assert.ok(reply);
  assert.equal(reply.executionId, execution.executionId, "raw detached reply identifies actual persisted run");
  assert.equal(reply.scheduleId, value.before.scheduleId);
  assert.equal(reply.status, "pending", "existing public queued status");
  assert.deepStrictEqual(value.runtime.map((effect) => effect.kind), ["start", "send", "stop"]);
  const request = value.runtime[0]!.request as Row;
  assert.equal(request.provider, "direct-a");
  assert.equal(request.model, "model-a");
  assert.equal(request.workspaceRoot, value.before.workspaceRoot);
  assert.equal(request.cwd, value.before.cwd);
  assert.equal(value.runtime[1]!.sessionId, value.runtime[0]!.sessionId);
  assert.equal(value.runtime[2]!.sessionId, value.runtime[0]!.sessionId);
  assert.equal(execution.sessionId, value.runtime[0]!.sessionId);
  assert.equal((value.runtime[1]!.request as Row).prompt, value.before.prompt);
  assert.deepStrictEqual(value.publishedEvents.map((event) => event[0]), ["schedule.execution.completed"]);
  const event = value.publishedEvents[0]![1] as Row;
  assert.equal(event.executionId, execution.executionId);
  assert.equal(event.scheduleId, value.before.scheduleId);
  assert.equal(event.sessionId, execution.sessionId);
  assert.equal(event.status, "success");
}

// Input-only independent state machine. No expected objects or scenario names enter it.
export const independentActivation: ActivationProvider = async (original, originalResponses, fault = {}) => {
  const input = clone(original);
  const responses = clone(originalResponses);
  const before: Row = { scheduleId: "synthetic-model-schedule", enabled: input.enabled, updatedAt: 1,
    modelSelection: clone(input.pair), ...clone(input.seed) };
  const admission = independentHostModel({ host: "hub", operation: input.operation, stored: before }, input.script, fault.admission);
  const executions: Row[] = [];
  const runtime: Row[] = [];
  const publishedEvents: unknown[][] = [];
  const pending = input.script.delayed ? { row: clone(admission.snapshot()!), executions: clone(executions),
    runtime: clone(runtime), commands: clone(admission.journal.filter((event) => event.kind === "command")) } : undefined;
  admission.settle();
  const outcome = await admission.result;
  const after = clone(admission.snapshot()!) as Row;
  const commands = clone(admission.journal.filter((event) => event.kind === "command"));
  let routineReply: Row | undefined;
  const stop = async (sessionId: string) => {
    runtime.push({ kind: "stop", sessionId });
    return clone(responses.stop);
  };
  const start = async (request: Row) => {
    if (responses.start.stopBeforeReturn) await stop(responses.start.sessionId);
    runtime.push({ kind: "start", request: clone(request), options: {}, sessionId: responses.start.sessionId });
    return { sessionId: responses.start.sessionId };
  };
  const send = async (sessionId: string, request: Row) => {
    runtime.push({ kind: "send", sessionId, request: clone(request) });
    if (responses.send.error) throw new Error(responses.send.error);
    return { result: clone(responses.send.result) };
  };
  for (const command of commands) {
    const submitted = command.data as { operation: ActivationInput["operation"]; pair: Pair };
    if (submitted.operation === "resume") {
      routineReply = { schedule: clone(after) };
      continue;
    }
    if (fault.execution === "enable-disabled") after.enabled = true;
    const canEnqueue = after.enabled === true || fault.execution === "enqueue-disabled";
    if (!canEnqueue || fault.execution === "omit-queue") {
      routineReply = fault.execution === "false-execution-ack"
        ? { execution: { executionId: "invented-run", status: "pending" } } : { execution: null };
      continue;
    }
    const queueCount = fault.execution === "duplicate-queue" ? 2 : 1;
    for (let index = 0; index < queueCount; index++) {
      const execution: Row = { executionId: "synthetic-run-" + (executions.length + 1), scheduleId: before.scheduleId, status: "pending" };
      executions.push(execution);
      routineReply = { execution: clone(execution) };
      if (fault.execution === "wrong-rawreply") (routineReply.execution as Row).executionId = "different-returned-run";
      execution.status = "running";
      let sessionId: string | undefined;
      try {
        const started = await start({ provider: submitted.pair.providerId, model: submitted.pair.modelId,
          workspaceRoot: before.workspaceRoot, cwd: before.cwd });
        if (!started.sessionId.trim()) throw new Error("synthetic empty session");
        sessionId = started.sessionId;
        execution.sessionId = fault.execution === "wrong-execution-session" ? "different-persisted-session" : sessionId;
        await send(sessionId, { prompt: before.prompt });
        execution.status = "success";
        after.lastRunAt = 2;
        publishedEvents.push(["schedule.execution.completed", { executionId: execution.executionId,
          scheduleId: before.scheduleId, sessionId: execution.sessionId, status: execution.status }]);
      } catch (error) {
        execution.status = "failed";
        execution.errorMessage = error instanceof Error ? error.message : String(error);
        publishedEvents.push(["schedule.execution.failed", { executionId: execution.executionId,
          scheduleId: before.scheduleId, sessionId: execution.sessionId, status: execution.status }]);
      } finally {
        if (sessionId) await stop(sessionId);
      }
    }
  }
  assert.deepStrictEqual(original, input, "independent provider cannot mutate operation input");
  assert.deepStrictEqual(originalResponses, responses, "independent provider cannot mutate dependency responses");
  return { outcome, before, after, reopened: clone(after), executions, reopenedExecutions: clone(executions), runtime,
    commands, journal: clone(admission.journal), routineReply, publishedEvents, ...(pending ? { pending } : {}) };
};

export async function observeActivation(
  provider: ActivationProvider, input: ActivationInput, responses: RuntimeResponses, fault?: ModelFault,
): Promise<ActivationCapture> {
  const originalInput = clone(input);
  const originalResponses = clone(responses);
  const observed = await provider(input, responses, fault);
  assert.deepStrictEqual(input, originalInput, "provider must preserve caller operation input");
  assert.deepStrictEqual(responses, originalResponses, "provider must preserve scripted dependency response");
  return observed;
}
export async function runActivationCases(provider: ActivationProvider, cases: ActivationCase[]): Promise<ActivationCapture[]> {
  const observed: ActivationCapture[] = [];
  for (const scenario of cases) {
    const value = await observeActivation(provider, scenario.input, correctRuntimeResponses());
    assertActivation(scenario, value);
    observed.push(value);
  }
  return observed;
}
export async function runActivationMockGate(root: string): Promise<{
  scenarios: number; rejectingControls: number; disabledUnusedResponseInvariants: number;
  observations: unknown[]; failed: number; skipped: number;
}> {
  const cases = createActivationCases(root);
  const observations: unknown[] = [];
  let scenarios = 0;
  let rejectingControls = 0;
  let disabledUnusedResponseInvariants = 0;
  for (const scenario of cases) {
    const correct = await observeActivation(independentActivation, scenario.input, correctRuntimeResponses());
    assertActivation(scenario, correct);
    observations.push({ kind: "correct", name: scenario.name, input: clone(scenario.input), observation: correct });
    scenarios++;
    const reject = async (name: string, responses: RuntimeResponses, fault: ModelFault) => {
      const bad = await observeActivation(independentActivation, scenario.input, responses, fault);
      assert.throws(() => assertActivation(scenario, bad), assert.AssertionError, "SAME assertions reject actual model interaction " + name);
      observations.push({ kind: "rejecting-control", name: scenario.name, control: name, responses: clone(responses), observation: bad });
      rejectingControls++;
    };
    if (scenario.admitted) {
      for (const admission of ["omit-write", "double-write", "wrong-pair", "wrong-result"] as const) {
        await reject(admission, correctRuntimeResponses(), { admission });
      }
    } else {
      assert.ok(scenario.admissionFault);
      await reject(scenario.admissionFault, correctRuntimeResponses(), { admission: scenario.admissionFault });
    }
    if (scenario.admitted && scenario.input.operation === "trigger" && !scenario.input.enabled) {
      for (const execution of ["enqueue-disabled", "enable-disabled", "false-execution-ack"] as const) {
        await reject(execution, correctRuntimeResponses(), { execution });
      }
      // Preserve all six original callback scripts honestly: disabled runtime never consumes them.
      for (const kind of ["empty-session", "send-error", "early-stop"] as const) {
        const value = await observeActivation(independentActivation, scenario.input, faultyRuntimeResponses(kind));
        assertActivation(scenario, value);
        observations.push({ kind: "unused-disabled-response-invariant", name: scenario.name, response: kind, observation: value });
        disabledUnusedResponseInvariants++;
      }
    }
    if (scenario.admitted && scenario.input.operation === "trigger" && scenario.input.enabled) {
      for (const kind of ["empty-session", "send-error", "early-stop"] as const) {
        await reject(kind, faultyRuntimeResponses(kind), {});
      }
      for (const execution of ["omit-queue", "duplicate-queue", "wrong-execution-session", "wrong-rawreply"] as const) {
        await reject(execution, correctRuntimeResponses(), { execution });
      }
    }
  }
  // Denominators are expectations on measured iterations, never substituted outcomes.
  assert.equal(scenarios, 24);
  assert.equal(rejectingControls, 62);
  assert.equal(disabledUnusedResponseInvariants, 6);
  return { scenarios, rejectingControls, disabledUnusedResponseInvariants, observations, failed: 0, skipped: 0 };
}

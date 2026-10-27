// Actual routine admission and registered-catalog functions. SDK command storage is scripted.
import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import { assertAdmission, scheduleAdmissionCases, type Observation } from "../../../cli/src/qbrain-p1/schedule-admission.contract.test";
import type { Event, Pair, RecordInput, Script } from "../../../cli/src/qbrain-p1/schedule-admission.model.test-support";
import { handleRoutineScheduleCommand } from "./schedules";

const fake = vi.hoisted(() => ({
  script: { catalogs: [] } as Script,
  stored: undefined as RecordInput | undefined,
  operation: "",
  journal: [] as Event[],
  accesses: [] as unknown[],
  frames: [] as unknown[],
  entered: undefined as (() => void) | undefined,
  gate: undefined as Promise<void> | undefined,
}));
const copy = <T>(value: T): T => structuredClone(value);
function emit(kind: string, data: unknown): void { fake.journal.push({ kind, data: copy(data) }); }
function pairFrom(value: unknown): Pair {
  const raw = value as Record<string, unknown>;
  return copy((Object.prototype.hasOwnProperty.call(raw, "modelSelection") ? raw.modelSelection : {
    providerId: raw.providerId ?? raw.provider, modelId: raw.modelId ?? raw.model,
  }) as Pair);
}
vi.mock("./deps", () => ({
  providerSettingsManager: {
    read: () => {
      fake.accesses.push({ kind: "settings-read" });
      return { providers: Object.fromEntries(fake.script.catalogs.map((entry) => [
        entry.providerId, entry.enabled ? { settings: {} } : {},
      ])) };
    },
  },
}));
vi.mock("@cline/core", () => ({
  createLocalHubScheduleRuntimeHandlers: () => { throw new Error("No actual runtime is allowed in an isolated admission test"); },
  HubScheduleService: class {},
  HubScheduleCommandService: class {
    async handleCommand(frame: { command: string; payload?: Record<string, unknown> }, context: unknown) {
      fake.frames.push(copy({ frame, context }));
      if (frame.command === "schedule.get") {
        emit("read", fake.stored);
        return { ok: true, payload: { schedule: copy(fake.stored) } };
      }
      const pair = frame.payload?.modelSelection as Pair | undefined ?? pairFrom(fake.stored);
      emit("command", { operation: fake.operation, pair });
      if (frame.command === "schedule.enable") fake.stored = { ...fake.stored, enabled: true };
      else if (frame.command !== "schedule.trigger") fake.stored = { ...fake.stored, modelSelection: copy(pair) };
      if (frame.command === "schedule.enable" || frame.command === "schedule.trigger") emit("activate", { operation: fake.operation, pair });
      return { ok: true, payload: frame.command === "schedule.trigger"
        ? { execution: copy(fake.stored) } : { schedule: copy(fake.stored) } };
    }
  },
  ensureCustomProvidersLoaded: async () => {
    fake.accesses.push({ kind: "custom-catalog-load" });
    if (fake.gate) await fake.gate;
    if (fake.script.error) throw new Error(fake.script.error);
  },
  Llms: {
    getProviderIds: () => [...fake.script.catalogs.map((entry) => entry.providerId), "cline", "cline-pass", "cline-cloud"],
    getModelsForProvider: async (providerId: string) => {
      fake.accesses.push({ kind: "models-read", providerId });
      const entry = fake.script.catalogs.find((item) => item.providerId === providerId);
      return Object.fromEntries((entry?.models ?? []).map((id) => [id, { id }]));
    },
  },
}));
vi.mock("./qbrain-schedule-admission", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./qbrain-schedule-admission")>();
  return {
    ...actual,
    requireDirectSchedulePair: (pair: Pair) => {
      try { return actual.requireDirectSchedulePair(pair); }
      catch (error) { emit("selection", pair); throw error; }
    },
    admitSchedulePair: async (...args: Parameters<typeof actual.admitSchedulePair>) => {
      emit("selection", actual.readExplicitSchedulePair(args[0], args[2]));
      return actual.admitSchedulePair(...args);
    },
  };
});
vi.mock("./qbrain-schedule-catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./qbrain-schedule-catalog")>();
  return {
    ...actual,
    readRegisteredScheduleCatalog: async (...args: Parameters<typeof actual.readRegisteredScheduleCatalog>) => {
      emit("catalog-request", { providerId: args[0] });
      fake.entered?.();
      try {
        const response = await actual.readRegisteredScheduleCatalog(...args);
        emit("catalog-response", response);
        return response;
      } catch (error) {
        emit("catalog-error", error instanceof Error ? error.message : String(error));
        throw error;
      }
    },
  };
});
const names = [
  "create:explicit-direct", "create:no-selection", "create:provider-only-no-borrow", "create:model-only-no-borrow",
  "create:missing-model-not-first-catalog", "create:forbidden-alias-cline", "create:forbidden-alias-CLINE-PASS",
  "create:forbidden-alias-cline-cloud",
  ...["update", "resume", "trigger"].flatMap((operation) => [
    operation + ":preserve-stored-complete", operation + ":legacy-scalar-complete",
    operation + ":legacy-absent-structured", operation + ":legacy-hosted-blocked", operation + ":stale-stored-catalog",
  ]),
  "update:legacy-explicit-direct-replacement", "update:failed-replacement-retains-legacy",
  ...["create", "update"].flatMap((operation) => [
    "empty", "disabled", "cross-provider-model", "failed", "delayed-valid", "delayed-empty", "delayed-failed",
  ].map((suffix) => operation + ":catalog-" + suffix)),
];
const selectedCases = names.map((name) => {
  const scenario = scheduleAdmissionCases.find((entry) => entry.name === "hub:" + name);
  assert.ok(scenario, "Frozen common case must exist: " + name);
  return scenario;
});
async function observeRoutine(scenario: typeof selectedCases[number], script: Script = scenario.script): Promise<Observation> {
  const input = copy(scenario.input);
  fake.script = copy(script);
  fake.stored = copy(input.stored);
  fake.journal = [];
  fake.accesses = [];
  fake.frames = [];
  fake.operation = input.operation;
  let release: (() => void) | undefined;
  fake.gate = script.delayed ? new Promise<void>((resolve) => { release = resolve; }) : undefined;
  let entered!: () => void;
  const catalogEntered = new Promise<void>((resolve) => { entered = resolve; });
  fake.entered = entered;
  emit("input", { host: input.host, operation: input.operation });
  const args = {
    name: "Synthetic", cron_pattern: "0 * * * *", prompt: "Synthetic prompt",
    workspace_root: "F:/qb-c15-synthetic/workspace", schedule_id: "synthetic-schedule",
    ...(input.selection as Record<string, unknown> | undefined),
  };
  const command = input.operation + "_routine_schedule";
  const running = handleRoutineScheduleCommand(command, args, "F:/qb-c15-synthetic/workspace").then(
    (reply) => {
      const value = reply as { schedule?: unknown; execution?: unknown };
      return { ok: true, pair: pairFrom(value.schedule ?? value.execution) };
    },
    (error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }),
  );
  let pending: Observation["pending"];
  if (script.delayed) {
    await catalogEntered;
    pending = { journal: copy(fake.journal), stored: copy(fake.stored) };
    release?.();
  }
  const outcome = await running;
  emit("result", outcome);
  const observation = { outcome, journal: copy(fake.journal), before: copy(input.stored), after: copy(fake.stored), ...(pending ? { pending } : {}) };
  assert.deepStrictEqual(scenario.input, input, "Caller case remains immutable");
  assert.deepStrictEqual(script, fake.script, "Dependency script remains immutable");
  const reads = fake.accesses.filter((item) => (item as { kind: string }).kind === "models-read") as { providerId: string }[];
  assert.ok(reads.every((entry) => !["cline", "cline-pass", "cline-cloud"].includes(entry.providerId)), "No hosted catalog access");
  console.log(JSON.stringify({ evidenceKind: "actual routine and private admission functions; scripted registry and SDK store", name: scenario.name, observation, frames: fake.frames, accesses: fake.accesses, actualGovernedHost: false }));
  return observation;
}
describe("private routine admission through SAME requirement assertions", () => {
  for (const scenario of selectedCases) it(scenario.name, async () => {
    assertAdmission(scenario, await observeRoutine(scenario));
    if (!scenario.expected.ok) return;
    for (const [name, script] of [
      ["wrong-provider-response", { ...scenario.script, catalogs: [{ providerId: "wrong", enabled: true, models: ["wrong"] }] }],
      ["missing-catalog-response", { ...scenario.script, catalogs: [] }],
      ["catalog-error-response", { ...scenario.script, error: "wrong-response-error" }],
    ] satisfies [string, Script][]) {
      const bad = await observeRoutine(scenario, script);
      assert.throws(() => assertAdmission(scenario, bad), assert.AssertionError, "SAME assertions reject " + name);
      console.log(JSON.stringify({ name: scenario.name, control: name, rejectedBySameAssertions: true, observation: bad }));
    }
  });
});

// SAME independently proven atomic/catalog assertions through the actual interactive schedule wizard.
// Prompt callbacks, registry, SDK client and admission-field store remain scripted.
import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import { runScheduleWizard } from "./index";
import { createQbrainScheduleAdmission } from "../../commands/schedule/qbrain-admission";
import { readExplicitSchedulePair } from "../../../../cline-hub/src/server/qbrain-schedule-admission";
import { assertAdmission, scheduleAdmissionCases, type Observation } from "../../qbrain-p1/schedule-admission.contract.test";
import type { AdmissionInput, Event, Pair, RecordInput, Script } from "../../qbrain-p1/schedule-admission.model.test-support";

const fake = vi.hoisted(() => ({
  script: { catalogs: [] } as Script, input: undefined as AdmissionInput | undefined,
  stored: undefined as RecordInput | undefined, journal: [] as Event[], accesses: [] as unknown[],
  errors: [] as string[], promptCalls: [] as unknown[], closes: 0, ensures: 0,
  mainChoice: 0, textChoice: 0, entered: undefined as (() => void) | undefined,
  gate: undefined as Promise<void> | undefined,
}));
const copy = <T>(value: T): T => structuredClone(value);
const emit = (kind: string, data: unknown) => fake.journal.push({ kind, data: copy(data) });
function pairFrom(raw: unknown): Pair {
  const value = raw as Record<string, unknown>;
  return copy((Object.prototype.hasOwnProperty.call(value, "modelSelection") ? value.modelSelection : {
    providerId: value.providerId ?? value.provider, modelId: value.modelId ?? value.model,
  }) as Pair);
}
vi.mock("@cline/core", () => ({
  ProviderSettingsManager: class {
    read() {
      fake.accesses.push({ kind: "settings-read" });
      return { providers: Object.fromEntries(fake.script.catalogs.map((entry) => [
        entry.providerId, entry.enabled ? { settings: {} } : {},
      ])) };
    }
    getLastUsedProviderSettings() { throw new Error("Unproved remembered provenance must not be read"); }
    getProviderSettings() { throw new Error("Partial pair borrowing is forbidden"); }
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
vi.mock("../../../../cline-hub/src/server/qbrain-schedule-catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../cline-hub/src/server/qbrain-schedule-catalog")>();
  return { ...actual, readRegisteredScheduleCatalog: async (...args: Parameters<typeof actual.readRegisteredScheduleCatalog>) => {
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
  } };
});
vi.mock("@clack/prompts", () => ({
  isCancel: (value: unknown) => typeof value === "symbol",
  intro: () => {}, outro: () => {}, spinner: () => ({ start: () => {}, stop: () => {} }),
  log: { error: (message: string) => fake.errors.push(message), success: () => {}, info: () => {}, warn: () => {}, message: () => {} },
  select: async (options: { message: string }) => {
    fake.promptCalls.push({ kind: "select", message: options.message });
    if (options.message === "What would you like to do?") return fake.mainChoice++ === 0 ? fake.input!.operation : "exit";
    if (options.message === "How often should it run?") return "0 * * * *";
    if (options.message === "Agent mode") return "act";
    if (options.message.startsWith("Select schedule")) return "synthetic-schedule";
    throw new Error("Unexpected actual wizard select: " + options.message);
  },
  text: async (options: { message: string }) => {
    fake.promptCalls.push({ kind: "text", message: options.message });
    const answers: Record<string, string> = {
      "Schedule name": "Synthetic", "What should Cline do?": "Synthetic prompt",
      "Workspace path": "F:/qb-c15-synthetic/workspace",
    };
    if (!(options.message in answers)) throw new Error("Unexpected actual wizard text: " + options.message);
    return answers[options.message];
  },
  confirm: async (options: { message: string }) => {
    fake.promptCalls.push({ kind: "confirm", message: options.message });
    if (options.message !== "Configure advanced options?") throw new Error("Unexpected actual wizard confirm");
    return true;
  },
  group: async () => {
    const raw = fake.input!.selection as Record<string, unknown> | undefined;
    const pair = raw && Object.prototype.hasOwnProperty.call(raw, "modelSelection") ? raw.modelSelection as Pair : raw;
    return {
      provider: pair?.providerId ?? (pair as Record<string, unknown> | undefined)?.provider ?? "",
      model: pair?.modelId ?? (pair as Record<string, unknown> | undefined)?.model ?? "",
      systemPrompt: "", timeout: "", maxIterations: "", tags: "",
    };
  },
}));
vi.mock("../../commands/schedule/client", () => ({
  ensureSchedulerHub: async () => {
    fake.ensures++;
    const command = async (payload?: Record<string, unknown>) => {
      const pair = payload ? { providerId: payload.provider as string, modelId: payload.model as string } : pairFrom(fake.stored);
      emit("command", { operation: fake.input!.operation, pair });
      if (fake.input!.operation === "resume") fake.stored = { ...fake.stored, enabled: true };
      else if (fake.input!.operation !== "trigger") fake.stored = { ...fake.stored, modelSelection: copy(pair) };
      if (fake.input!.operation === "resume" || fake.input!.operation === "trigger") emit("activate", { operation: fake.input!.operation, pair });
      return fake.input!.operation === "trigger"
        ? { executionId: "synthetic-execution" }
        : { ...copy(fake.stored), name: "Synthetic", scheduleId: "synthetic-schedule" };
    };
    return { ok: true, client: {
      listSchedules: async () => [{ ...copy(fake.stored), name: "Synthetic", scheduleId: "synthetic-schedule", cronPattern: "0 * * * *", prompt: "Synthetic prompt" }],
      getSchedule: async () => { emit("read", fake.stored); return copy(fake.stored); },
      createSchedule: command, resumeSchedule: async () => command(), triggerScheduleNow: async () => command(),
      close: () => { fake.closes++; },
    } };
  },
}));

// This adapter receives only operation inputs and scripted responses, never expected outcomes.
async function observeWizard(input: AdmissionInput, script: Script): Promise<Observation> {
  const original = copy(input);
  fake.input = copy(input); fake.script = copy(script); fake.stored = copy(input.stored);
  fake.journal = []; fake.accesses = []; fake.errors = []; fake.promptCalls = [];
  fake.mainChoice = fake.textChoice = fake.closes = fake.ensures = 0;
  let release: (() => void) | undefined;
  fake.gate = script.delayed ? new Promise<void>((resolve) => { release = resolve; }) : undefined;
  let entered!: () => void;
  const catalogEntered = new Promise<void>((resolve) => { entered = resolve; });
  fake.entered = entered;
  emit("input", { host: input.host, operation: input.operation });
  const actual = createQbrainScheduleAdmission();
  const running = runScheduleWizard({
    resolve: async (raw) => {
      try { emit("selection", readExplicitSchedulePair(raw)); } catch { /* Real private guard owns rejection. */ }
      return actual.resolve(raw);
    },
  });
  let pending: Observation["pending"];
  if (script.delayed) {
    await catalogEntered;
    pending = { journal: copy(fake.journal), stored: copy(fake.stored) };
    release?.();
  }
  assert.equal(await running, 0, "Wizard returns through its original normal exit path");
  const outcome = fake.errors.length
    ? { ok: false, error: fake.errors.join("\n") }
    : { ok: true, pair: pairFrom(fake.stored) };
  emit("result", outcome);
  assert.deepStrictEqual(input, original, "Caller input remains immutable");
  assert.deepStrictEqual(fake.script, script, "Dependency script remains immutable");
  assert.equal(fake.closes, 1, "Actual wizard finally closes acquired client once");
  assert.equal(fake.ensures, 1, "Wizard obtains one client for menu lifecycle");
  assert.ok(fake.accesses.filter((value) => (value as { kind: string }).kind === "models-read").every((value) =>
    !["cline", "cline-pass", "cline-cloud"].includes((value as { providerId: string }).providerId)), "No hosted catalog read");
  const observation = { outcome, journal: copy(fake.journal), before: copy(input.stored), after: copy(fake.stored), ...(pending ? { pending } : {}) };
  console.log(JSON.stringify({ evidenceKind: "actual interactive wizard/private admission; scripted prompts, registry, transport and store", input, observation, promptCalls: fake.promptCalls, accesses: fake.accesses, actualGovernedHost: false }));
  return observation;
}
const names = [
  "create:explicit-direct", "create:no-selection", "create:provider-only-no-borrow", "create:model-only-no-borrow",
  "create:missing-model-not-first-catalog", "create:forbidden-alias-cline", "create:forbidden-alias-CLINE-PASS", "create:forbidden-alias-cline-cloud",
  ...["resume", "trigger"].flatMap((operation) => [
    "preserve-stored-complete", "legacy-scalar-complete", "legacy-absent-structured", "legacy-hosted-blocked", "stale-stored-catalog",
  ].map((suffix) => operation + ":" + suffix)),
  ...["empty", "disabled", "cross-provider-model", "failed", "delayed-valid", "delayed-empty", "delayed-failed"].map((suffix) => "create:catalog-" + suffix),
];
describe("actual interactive wizard admission uses frozen common assertions", () => {
  for (const name of names) {
    const scenario = scheduleAdmissionCases.find((value) => value.name === "cli:" + name);
    assert.ok(scenario, "Existing requirement-derived scenario must exist: " + name);
    it(scenario.name, async () => {
      assertAdmission(scenario, await observeWizard(scenario.input, scenario.script));
      if (!scenario.expected.ok) return;
      for (const [control, script] of [
        ["wrong-provider-response", { ...scenario.script, catalogs: [{ providerId: "wrong", enabled: true, models: ["wrong"] }] }],
        ["missing-catalog-response", { ...scenario.script, catalogs: [] }],
        ["catalog-error-response", { ...scenario.script, error: "wrong-response-error" }],
      ] satisfies [string, Script][]) {
        const bad = await observeWizard(scenario.input, script);
        assert.throws(() => assertAdmission(scenario, bad), assert.AssertionError, "SAME assertions reject " + control);
        console.log(JSON.stringify({ name: scenario.name, control, rejectedBySameAssertions: true, observation: bad }));
      }
    });
  }
});

// Actual CLI command and private app admission functions; SDK transport/storage stay scripted.
// SAME requirement cases and assertAdmission are shared with the independently proven model.
import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import { createScheduleCommand } from "./schedule";
import { createQbrainScheduleAdmission } from "./schedule/qbrain-admission";
import { readExplicitSchedulePair } from "../../../cline-hub/src/server/qbrain-schedule-admission";
import { assertAdmission, scheduleAdmissionCases, type Observation } from "../qbrain-p1/schedule-admission.contract.test";
import type { Event, Pair, RecordInput, Script } from "../qbrain-p1/schedule-admission.model.test-support";

const fake = vi.hoisted(() => ({
  script: { catalogs: [] } as Script,
  stored: undefined as RecordInput | undefined,
  journal: [] as Event[],
  accesses: [] as unknown[],
  operation: "",
  source: "",
  allocations: 0,
  ensures: 0,
  reads: 0,
  closes: 0,
  commandPayloads: [] as unknown[],
  entered: undefined as (() => void) | undefined,
  gate: undefined as Promise<void> | undefined,
}));
const copy = <T>(value: T): T => structuredClone(value);
function emit(kind: string, data: unknown): void { fake.journal.push({ kind, data: copy(data) }); }
function pairFrom(value: unknown): Pair {
  const raw = value as Record<string, unknown>;
  const pair = (Object.prototype.hasOwnProperty.call(raw, "modelSelection") ? raw.modelSelection : {
    providerId: raw.providerId ?? raw.provider, modelId: raw.modelId ?? raw.model,
  }) as Pair;
  return copy(pair);
}
vi.mock("@cline/core", () => ({
  ProviderSettingsManager: class {
    constructor() { fake.allocations++; }
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
vi.mock("../../../cline-hub/src/server/qbrain-schedule-catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../cline-hub/src/server/qbrain-schedule-catalog")>();
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
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs/promises")>(),
  readFile: async (path: unknown) => {
    fake.accesses.push({ kind: "import-read", path });
    return fake.source;
  },
}));
vi.mock("./schedule/client", () => ({
  ensureSchedulerHub: async (...args: unknown[]) => {
    fake.ensures++;
    fake.accesses.push({ kind: "ensure", address: args[0], root: args[1] });
    const command = (payload: Record<string, unknown> | undefined) => {
      const pair = payload ? { providerId: payload.provider as string, modelId: payload.model as string } : pairFrom(fake.stored);
      fake.commandPayloads.push(copy(payload));
      emit("command", { operation: fake.operation, pair });
      if (fake.operation === "resume") fake.stored = { ...fake.stored, enabled: true };
      else if (fake.operation !== "trigger") fake.stored = { ...fake.stored, modelSelection: copy(pair) };
      if (fake.operation === "resume" || fake.operation === "trigger") emit("activate", { operation: fake.operation, pair });
      return copy(fake.stored);
    };
    return { ok: true, client: {
      getSchedule: async () => { fake.reads++; emit("read", fake.stored); return copy(fake.stored); },
      createSchedule: async (payload: Record<string, unknown>) => command(payload),
      updateSchedule: async (_id: string, payload: Record<string, unknown>) => command(payload),
      resumeSchedule: async () => command(undefined),
      triggerScheduleNow: async () => command(undefined),
      close: () => { fake.closes++; },
    } };
  },
}));

const names = [
  "create:explicit-direct", "create:no-selection", "create:provider-only-no-borrow", "create:model-only-no-borrow",
  "create:missing-model-not-first-catalog", "create:forbidden-alias-cline", "create:forbidden-alias-CLINE-PASS",
  "create:forbidden-alias-cline-cloud",
  "import:explicit-direct", "import:authoritative-malformed-32", "import:authoritative-malformed-34",
  "import:authoritative-malformed-36", "import:authoritative-malformed-38", "import:authoritative-malformed-40",
  "import:authoritative-malformed-42", "import:authoritative-malformed-44", "import:authoritative-malformed-46",
  "import:structured-wins-as-unit", "import:absent-structured-legacy-direct",
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
  const scenario = scheduleAdmissionCases.find((entry) => entry.name === "cli:" + name);
  assert.ok(scenario, "Frozen common case must exist: " + name);
  return scenario;
});

async function observeCommand(scenario: typeof selectedCases[number], script: Script = scenario.script): Promise<Observation> {
  const input = copy(scenario.input);
  fake.script = copy(script);
  fake.stored = copy(input.stored);
  fake.journal = [];
  fake.accesses = [];
  fake.commandPayloads = [];
  fake.operation = input.operation;
  fake.allocations = fake.ensures = fake.reads = fake.closes = 0;
  let release: (() => void) | undefined;
  fake.gate = script.delayed ? new Promise<void>((resolve) => { release = resolve; }) : undefined;
  let entered!: () => void;
  const catalogEntered = new Promise<void>((resolve) => { entered = resolve; });
  fake.entered = entered;
  emit("input", { host: input.host, operation: input.operation });
  const output: string[] = [];
  const errors: string[] = [];
  let exitCode = 0;
  const actual = createQbrainScheduleAdmission();
  const command = createScheduleCommand({
    writeln: (text = "") => output.push(text), writeErr: (text) => errors.push(text),
  }, (value) => { exitCode = value; }, {
    resolve: async (raw) => {
      try { emit("selection", readExplicitSchedulePair(raw)); } catch { /* Actual policy owns the error result. */ }
      return actual.resolve(raw);
    },
  });
  const root = "F:/qb-c15-synthetic/workspace";
  const raw = input.selection as Record<string, unknown> | undefined;
  const pair = raw && Object.prototype.hasOwnProperty.call(raw, "modelSelection")
    ? raw.modelSelection as Record<string, unknown> : raw;
  const flags: string[] = [];
  for (const [flag, value] of [["--provider", pair?.providerId ?? pair?.provider], ["--model", pair?.modelId ?? pair?.model]] as const) {
    if (typeof value === "string") flags.push(flag, value);
  }
  const args = input.operation === "create"
    ? ["create", "Synthetic", "--cron", "0 * * * *", "--prompt", "Synthetic prompt", "--workspace", root, ...flags]
    : input.operation === "import"
      ? ["import", "F:/qb-c15-synthetic/input.json"]
      : [input.operation, "synthetic-schedule", ...(input.operation === "update" ? flags : [])];
  fake.source = JSON.stringify({ name: "Synthetic", cronPattern: "0 * * * *", prompt: "Synthetic prompt", workspaceRoot: root, ...raw });
  const running = command.parseAsync([...args, "--json"], { from: "user" });
  let pending: Observation["pending"];
  if (script.delayed) {
    await catalogEntered;
    pending = { journal: copy(fake.journal), stored: copy(fake.stored) };
    release?.();
  }
  await running;
  const outcome = exitCode === 0
    ? { ok: true, pair: pairFrom(JSON.parse(output.at(-1)!)) }
    : { ok: false, error: errors.join("\n") };
  emit("result", outcome);
  const observation = { outcome, journal: copy(fake.journal), before: copy(input.stored), after: copy(fake.stored), ...(pending ? { pending } : {}) };
  assert.deepStrictEqual(scenario.input, input, "Caller case input remains immutable");
  assert.deepStrictEqual(script, fake.script, "Script remains immutable");
  const requests = fake.accesses.filter((item) => (item as { kind: string }).kind === "models-read") as { providerId: string }[];
  assert.ok(requests.every((entry) => !["cline", "cline-pass", "cline-cloud"].includes(entry.providerId)), "No hosted catalog access");
  assert.equal(fake.allocations, scenario.expected.catalog ? 1 : 0, "Manager allocation only after complete permitted pair");
  assert.equal(fake.closes, fake.ensures, "Every obtained client is closed exactly once");
  if (!scenario.expected.catalog && ["create", "import"].includes(input.operation)) assert.equal(fake.ensures, 0, "Invalid pair blocks hub construction");
  if (input.operation === "import") assert.equal(fake.accesses.filter((item) => (item as { kind: string }).kind === "import-read").length, 1, "Validate and publish the same captured import");
  console.log(JSON.stringify({ evidenceKind: "actual CLI command/private admission; scripted registry, transport and store", name: scenario.name, observation, accesses: fake.accesses, commandPayloads: fake.commandPayloads, actualGovernedHost: false }));
  return observation;
}
describe("private CLI schedule admission through common requirement assertions", () => {
  for (const scenario of selectedCases) it(scenario.name, async () => {
    assertAdmission(scenario, await observeCommand(scenario));
    if (!scenario.expected.ok) return;
    for (const [name, script] of [
      ["wrong-provider-response", { ...scenario.script, catalogs: [{ providerId: "wrong", enabled: true, models: ["wrong"] }] }],
      ["missing-catalog-response", { ...scenario.script, catalogs: [] }],
      ["catalog-error-response", { ...scenario.script, error: "wrong-response-error" }],
    ] satisfies [string, Script][]) {
      const bad = await observeCommand(scenario, script);
      assert.throws(() => assertAdmission(scenario, bad), assert.AssertionError, "SAME assertions reject " + name);
      console.log(JSON.stringify({ name: scenario.name, control: name, rejectedBySameAssertions: true, observation: bad }));
    }
  });
});

// Baseline real SQLite persistence through the existing public hub routine.
// No native hub, live provider, governed dependency or scheduler execution acceptance.
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, it, vi } from "vitest";
import { HubScheduleService as RealService } from "../../../../sdk/packages/core/src/cron/service/schedule-service";
import { assertAdmission, scheduleAdmissionCases, type Observation } from "../../../cli/src/qbrain-p1/schedule-admission.contract.test";
import { independentHostModel, type AdmissionInput, type Event, type Outcome, type Pair, type RecordInput, type Script } from "../../../cli/src/qbrain-p1/schedule-admission.model.test-support";

const fake = vi.hoisted(() => ({
  script: { catalogs: [] } as Script, journal: [] as Event[], accesses: [] as unknown[],
  service: undefined as unknown, gate: undefined as Promise<void> | undefined,
  entered: undefined as (() => void) | undefined, runtimeCalls: 0, frames: [] as unknown[], nativeRuntime: undefined as unknown,
}));
const copy = <T>(value: T): T => structuredClone(value);
const emit = (kind: string, data: unknown) => fake.journal.push({ kind, data: copy(data) });
vi.mock("./deps", () => ({
  providerSettingsManager: { read: () => ({ providers: Object.fromEntries(fake.script.catalogs.map((entry) =>
    [entry.providerId, entry.enabled ? { settings: {} } : {}])) }) },
}));
vi.mock("@cline/core", async () => {
  const { HubScheduleCommandService } = await import("../../../../sdk/packages/core/src/cron/service/schedule-command-service");
  return {
    HubScheduleService: class { constructor() { return fake.service as object; } },
    HubScheduleCommandService: class extends HubScheduleCommandService {
      override async handleCommand(...args: Parameters<InstanceType<typeof HubScheduleCommandService>["handleCommand"]>) {
        fake.frames.push(copy(args));
        const pair = args[0].payload?.modelSelection ?? (fake.service as RealService).getSchedule(args[0].payload?.scheduleId as string)?.modelSelection;
        if (args[0].command !== "schedule.get") emit("command", { operation: args[0].command === "schedule.enable" ? "resume" : args[0].command.slice("schedule.".length), pair });
        return super.handleCommand(...args);
      }
    },
    createLocalHubScheduleRuntimeHandlers: () => { if (fake.nativeRuntime) return fake.nativeRuntime; throw new Error("No native runtime construction allowed"); },
    ensureCustomProvidersLoaded: async () => {
      fake.accesses.push({ kind: "custom-catalog-load" });
      if (fake.gate) await fake.gate;
      if (fake.script.error) throw new Error(fake.script.error);
    },
    Llms: {
      getProviderIds: () => [...fake.script.catalogs.map((entry) => entry.providerId), "cline", "cline-pass", "cline-cloud"],
      getModelsForProvider: async (providerId: string) => {
        fake.accesses.push({ kind: "models-read", providerId });
        const entry = fake.script.catalogs.find((value) => value.providerId === providerId);
        return Object.fromEntries((entry?.models ?? []).map((id) => [id, { id }]));
      },
    },
  };
});
vi.mock("./qbrain-schedule-admission", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./qbrain-schedule-admission")>();
  return { ...actual,
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
  return { ...actual, readRegisteredScheduleCatalog: async (...args: Parameters<typeof actual.readRegisteredScheduleCatalog>) => {
    emit("catalog-request", { providerId: args[0] }); fake.entered?.();
    try { const response = await actual.readRegisteredScheduleCatalog(...args); emit("catalog-response", response); return response; }
    catch (error) { emit("catalog-error", error instanceof Error ? error.message : String(error)); throw error; }
  } };
});
const names = [
  "explicit-direct", "no-selection", "provider-only-no-borrow", "model-only-no-borrow",
  "missing-model-not-first-catalog", "forbidden-alias-cline", "forbidden-alias-CLINE-PASS", "forbidden-alias-cline-cloud",
  ...["empty", "disabled", "cross-provider-model", "failed", "delayed-valid", "delayed-empty", "delayed-failed"].map((value) => "catalog-" + value),
];
const cases = names.map((name) => {
  const scenario = scheduleAdmissionCases.find((value) => value.name === "hub:create:" + name);
  assert.ok(scenario, "Frozen original case must exist: " + name); return scenario;
});
type Row = Record<string, unknown>;
type StorageCapture = { beforeRows: Row[]; afterRows: Row[]; reopenedRows: Row[]; root: string };
type FullObservation = Observation & StorageCapture;
function assertPersistence(scenario: typeof cases[number], value: StorageCapture): void {
  assert.equal(value.beforeRows.length, 1, "One existing synthetic original canary");
  const original = value.beforeRows[0]!;
  assert.equal(original.enabled, false, "Synthetic original stays inactive");
  assert.deepStrictEqual(value.afterRows.filter((row) => row.scheduleId === original.scheduleId), [original], "Original complete record unchanged");
  assert.deepStrictEqual(value.reopenedRows, value.afterRows, "Independent reopened database contains the same complete records");
  const created = value.afterRows.filter((row) => row.scheduleId !== original.scheduleId);
  assert.equal(created.length, scenario.expected.ok ? 1 : 0, "Rejected selection writes no record; success writes exactly one");
  if (scenario.expected.ok) {
    const row = created[0]!;
    assert.deepStrictEqual(row.modelSelection, scenario.expected.pair, "Persisted atomic pair matches requirement-derived expected pair");
    assert.equal(row.workspaceRoot, value.root, "Persisted workspace stays in synthetic namespace");
    assert.equal(row.enabled, false, "Test-created schedule remains inactive");
    assert.equal(row.name, "Synthetic admission");
    assert.equal(row.prompt, "Synthetic prompt");
    assert.equal(row.cronPattern, "0 * * * *");
  }
}
type StoreFault = "none" | "change-canary" | "delete-canary" | "namespace-crossover" | "wrong-pair" | "omit-write" | "double-write" | "write-rejected";
async function independentStorage(input: AdmissionInput, script: Script, fault: StoreFault = "none"): Promise<StorageCapture> {
  const run = independentHostModel(input, script);
  run.settle();
  const outcome = await run.result;
  const root = "synthetic-model-root";
  const beforeRows: Row[] = [{ scheduleId: "original-canary", enabled: false, modelSelection: { providerId: "direct-b", modelId: "model-b" }, metadata: { canary: "byte-original" }, workspaceRoot: root }];
  const rows = copy(beforeRows);
  const write = () => rows.push({ scheduleId: "new-" + rows.length, enabled: false, name: "Synthetic admission", prompt: "Synthetic prompt",
    cronPattern: "0 * * * *", workspaceRoot: fault === "namespace-crossover" ? "wrong-root" : root,
    modelSelection: fault === "wrong-pair" ? { providerId: "wrong", modelId: "wrong" } : outcome.pair });
  if (outcome.ok && fault !== "omit-write") write();
  if (fault === "double-write") write();
  if (!outcome.ok && fault === "write-rejected") write();
  if (fault === "change-canary") rows[0]!.metadata = { canary: "changed" };
  if (fault === "delete-canary") rows.shift();
  return { beforeRows, afterRows: copy(rows), reopenedRows: copy(rows), root };
}
const runtimeHandlers = () => ({
  startSession: async () => { fake.runtimeCalls++; throw new Error("Schedule runtime must remain inactive"); },
  sendSession: async () => { fake.runtimeCalls++; throw new Error("Schedule runtime must remain inactive"); },
  abortSession: async () => { fake.runtimeCalls++; throw new Error("Schedule runtime must remain inactive"); },
  stopSession: async () => { fake.runtimeCalls++; throw new Error("Schedule runtime must remain inactive"); },
});
// Input and dependency responses only. Expected objects stay in assertions outside this adapter.
async function observeSqlite(input: AdmissionInput, script: Script): Promise<FullObservation> {
  vi.resetModules();
  fake.script = copy(script); fake.journal = []; fake.accesses = []; fake.frames = []; fake.runtimeCalls = 0; fake.nativeRuntime = undefined;
  const taskTemp = taskOwnedFixtureRoot(process.env);
  assert.equal(taskOwnedFixtureRoot(process.env), taskTemp, "Checked launcher fixture identity remains exact");
  const fixture = await mkdtemp(join(taskTemp, "sqlite-admission-"));
  const root = join(fixture, "workspace"); await mkdir(root);
  const dbPath = join(fixture, "cron.db");
  const options = { dbPath, specs: { cronSpecsDir: join(fixture, "specs") }, runtimeHandlers: runtimeHandlers() };
  const service = new RealService(options); fake.service = service;
  service.createSchedule({ name: "Original synthetic canary", prompt: "Synthetic canary", cronPattern: "0 * * * *",
    workspaceRoot: root, cwd: root, enabled: false, modelSelection: { providerId: "direct-b", modelId: "model-b" }, metadata: { canary: "byte-original" } });
  const beforeRows = copy(service.listSchedules()) as unknown as Row[];
  let release: (() => void) | undefined;
  fake.gate = script.delayed ? new Promise<void>((resolve) => { release = resolve; }) : undefined;
  let entered!: () => void;
  const catalogEntered = new Promise<void>((resolve) => { entered = resolve; }); fake.entered = entered;
  emit("input", { host: input.host, operation: input.operation });
  let outcome: Observation["outcome"];
  let pending: Observation["pending"];
  let afterRows: Row[];
  try {
    const { handleRoutineScheduleCommand } = await import("./schedules");
    const running = handleRoutineScheduleCommand("create_routine_schedule", {
      name: "Synthetic admission", prompt: "Synthetic prompt", cron_pattern: "0 * * * *",
      workspace_root: root, cwd: root, enabled: false, ...input.selection,
    }, root).then((reply) => {
      const row = (reply as { schedule: Row }).schedule;
      return { ok: true, pair: row.modelSelection as Pair };
    }, (error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    if (script.delayed) {
      await catalogEntered;
      assert.deepStrictEqual(service.listSchedules(), beforeRows, "No complete record changes while actual catalog pending");
      pending = { journal: copy(fake.journal), stored: undefined }; release?.();
    }
    outcome = await running; emit("result", outcome);
    afterRows = copy(service.listSchedules()) as unknown as Row[];
  } finally { await service.dispose(); }
  const reopened = new RealService(options);
  let reopenedRows: Row[];
  try { reopenedRows = copy(reopened.listSchedules()) as unknown as Row[]; }
  finally { await reopened.dispose(); }
  assert.equal(fake.runtimeCalls, 0, "No scheduler/provider execution");
  assert.ok(fake.accesses.filter((value) => (value as { kind: string }).kind === "models-read")
    .every((value) => !["cline", "cline-pass", "cline-cloud"].includes((value as { providerId: string }).providerId)), "No hosted catalog reads");
  const created = afterRows.filter((row) => row.scheduleId !== beforeRows[0]!.scheduleId);
  const observation: FullObservation = {
    outcome, journal: copy(fake.journal), before: undefined,
    after: created.length ? { modelSelection: copy(created[0]!.modelSelection) } : undefined,
    ...(pending ? { pending } : {}), beforeRows, afterRows, reopenedRows, root,
  };
  console.log(JSON.stringify({ evidenceKind: "actual hub routine and baseline SQLite command/service/store; scripted registry and inactive runtime", input, observation, frames: fake.frames, accesses: fake.accesses, dbPath, actualGovernedHost: false }));
  return observation;
}
describe("same admission assertions at baseline real SQLite persistence boundary", () => {
  it("independent complete-record assertions reject actual modeled storage effects before binding", async () => {
    let rejectingControls = 0;
    for (const scenario of cases) {
      assertPersistence(scenario, await independentStorage(scenario.input, scenario.script));
      const faults: StoreFault[] = scenario.expected.ok
        ? ["change-canary", "delete-canary", "namespace-crossover", "wrong-pair", "omit-write", "double-write"]
        : ["write-rejected"];
      for (const fault of faults) {
        const bad = await independentStorage(scenario.input, scenario.script, fault);
        assert.throws(() => assertPersistence(scenario, bad), assert.AssertionError);
        rejectingControls++;
      }
    }
    console.log(JSON.stringify({ evidenceKind: "independent input-only complete-record storage model", scenarios: cases.length, rejectingControls, failed: 0, skipped: 0 }));
  });
  for (const scenario of cases) it(scenario.name, async () => {
    const observation = await observeSqlite(scenario.input, scenario.script);
    assertAdmission(scenario, observation); assertPersistence(scenario, observation);
    if (!scenario.expected.ok) return;
    for (const [control, script] of [
      ["wrong-provider-response", { ...scenario.script, catalogs: [{ providerId: "wrong", enabled: true, models: ["wrong"] }] }],
      ["missing-catalog-response", { ...scenario.script, catalogs: [] }],
      ["catalog-error-response", { ...scenario.script, error: "wrong-response-error" }],
    ] satisfies [string, Script][]) {
      const bad = await observeSqlite(scenario.input, script);
      assert.throws(() => assertAdmission(scenario, bad), assert.AssertionError, "SAME assertions reject " + control);
      console.log(JSON.stringify({ name: scenario.name, control, rejectedBySameAssertions: true, observation: bad }));
    }
  });
});

type LegacyCase = { name: string; selection?: RecordInput; script: Script; accepted: boolean; error?: RegExp; fault?: Parameters<typeof independentHostModel>[2] };
const legacyDirect = { providerId: "direct-a", modelId: "model-a" };
const legacyCatalogs = [
  { providerId: "direct-a", enabled: true, models: ["model-a"] },
  { providerId: "cline", enabled: true, models: ["synthetic-hosted-old"] },
];
const legacyCases: LegacyCase[] = [
  { name: "hosted-needs-explicit-replacement", script: { catalogs: legacyCatalogs }, accepted: false, error: /direct provider|hosted/, fault: "allow-hosted" },
  { name: "provider-only-no-first-entry", selection: { provider: "direct-a" }, script: { catalogs: legacyCatalogs }, accepted: false, error: /Select both/, fault: "first-model" },
  { name: "model-only-no-borrow", selection: { model: "model-a" }, script: { catalogs: legacyCatalogs }, accepted: false, error: /Select both/, fault: "partial-borrow" },
  { name: "structured-null-no-scalars", selection: { modelSelection: null, provider: "direct-a", model: "model-a" }, script: { catalogs: legacyCatalogs }, accepted: false, error: /Repair modelSelection/, fault: "scalar-borrow" },
  { name: "structured-partial-no-scalars", selection: { modelSelection: { providerId: "direct-a" }, provider: "direct-a", model: "model-a" }, script: { catalogs: legacyCatalogs }, accepted: false, error: /Select both|Repair modelSelection/, fault: "scalar-borrow" },
  { name: "explicit-empty-catalog", selection: { modelSelection: legacyDirect }, script: { catalogs: [] }, accepted: false, error: /catalog|Settings/, fault: "write-before-catalog" },
  { name: "explicit-disabled-catalog", selection: { modelSelection: legacyDirect }, script: { catalogs: [{ ...legacyCatalogs[0]!, enabled: false }] }, accepted: false, error: /catalog|Settings/, fault: "ignore-enabled" },
  { name: "explicit-failed-catalog", selection: { modelSelection: legacyDirect }, script: { catalogs: legacyCatalogs, error: "synthetic-catalog-failure" }, accepted: false, error: /catalog|Catalog|Settings/, fault: "write-before-catalog" },
  { name: "explicit-direct-replacement", selection: { modelSelection: legacyDirect }, script: { catalogs: legacyCatalogs }, accepted: true },
  { name: "structured-unit-wins-over-hosted-scalars", selection: { modelSelection: legacyDirect, provider: "cline", model: "synthetic-hosted-old" }, script: { catalogs: legacyCatalogs }, accepted: true },
  { name: "delayed-valid-no-early-rewrite", selection: { modelSelection: legacyDirect }, script: { catalogs: legacyCatalogs, delayed: true }, accepted: true },
  { name: "delayed-failed-no-early-rewrite", selection: { modelSelection: legacyDirect }, script: { catalogs: legacyCatalogs, delayed: true, error: "synthetic-catalog-failure" }, accepted: false, error: /catalog|Catalog|Settings/, fault: "write-while-pending" },
];
type LegacyCapture = {
  outcome: Outcome; before: Row; after: Row; reopened: Row;
  mutations: number; pending?: { row: Row; mutations: number };
};
function assertLegacyRepair(scenario: LegacyCase, value: LegacyCapture): void {
  assert.equal(value.outcome.ok, scenario.accepted, "Requirement-derived legacy repair result");
  assert.equal(value.mutations, scenario.accepted ? 1 : 0, "Exactly one accepted replacement; no rejected mutation");
  assert.deepStrictEqual(value.reopened, value.after, "Independent reopen retains complete legacy record");
  assert.equal(value.before.enabled, false);
  assert.equal(value.after.enabled, false, "Opening/repairing never activates synthetic hosted state");
  if (scenario.script.delayed) {
    assert.ok(value.pending);
    assert.deepStrictEqual(value.pending.row, value.before, "No early complete-record rewrite");
    assert.equal(value.pending.mutations, 0);
  }
  if (!scenario.accepted) {
    assert.match(value.outcome.error ?? "", scenario.error!);
    assert.deepStrictEqual(value.after, value.before, "Failed replacement preserves EVERY original field");
    return;
  }
  assert.deepStrictEqual(value.outcome.pair, legacyDirect);
  assert.deepStrictEqual(value.after.modelSelection, legacyDirect, "Only explicit selected direct unit is persisted");
  const stable = (row: Row) => Object.fromEntries(Object.entries(row).filter(([key]) => key !== "modelSelection" && key !== "updatedAt"));
  assert.deepStrictEqual(stable(value.after), stable(value.before), "Every other legacy field and canary is unchanged");
  assert.ok(typeof value.after.updatedAt === "number" && value.after.updatedAt >= (value.before.updatedAt as number));
}
async function independentLegacyRepair(scenarioInput: Pick<LegacyCase, "selection" | "script">, fault: Parameters<typeof independentHostModel>[2] = "none"): Promise<LegacyCapture> {
  const before: Row = { scheduleId: "synthetic-legacy", enabled: false, updatedAt: 1, modelSelection: { providerId: "cline", modelId: "synthetic-hosted-old" }, metadata: { canary: "legacy-byte-original" } };
  const run = independentHostModel({ host: "hub", operation: "update", stored: copy(before), selection: copy(scenarioInput.selection), remembered: { explicit: true, pair: legacyDirect } }, scenarioInput.script, fault);
  const pending = scenarioInput.script.delayed ? { row: copy(run.snapshot()!), mutations: run.journal.filter((event) => event.kind === "command").length } : undefined;
  run.settle(); const outcome = await run.result;
  const after = copy(run.snapshot()!);
  return { outcome, before, after, reopened: copy(after), mutations: run.journal.filter((event) => event.kind === "command").length, ...(pending ? { pending } : {}) };
}
async function observeLegacyRepair(selection: RecordInput | undefined, script: Script): Promise<LegacyCapture> {
  vi.resetModules(); fake.script = copy(script); fake.journal = []; fake.accesses = []; fake.frames = []; fake.runtimeCalls = 0; fake.nativeRuntime = undefined;
  const temp = taskOwnedFixtureRoot(process.env);
  assert.equal(taskOwnedFixtureRoot(process.env), temp, "Checked launcher fixture identity remains exact");
  const fixture = await mkdtemp(join(temp, "sqlite-legacy-")); const root = join(fixture, "workspace"); await mkdir(root);
  const options = { dbPath: join(fixture, "cron.db"), specs: { cronSpecsDir: join(fixture, "specs") }, runtimeHandlers: runtimeHandlers() };
  const service = new RealService(options); fake.service = service;
  const before = copy(service.createSchedule({ name: "Original legacy canary", prompt: "Synthetic legacy prompt", cronPattern: "0 * * * *",
    workspaceRoot: root, cwd: root, enabled: false, tags: [], modelSelection: { providerId: "cline", modelId: "synthetic-hosted-old" }, metadata: { canary: "legacy-byte-original" } })) as unknown as Row;
  let release: (() => void) | undefined; fake.gate = script.delayed ? new Promise<void>((resolve) => { release = resolve; }) : undefined;
  let entered!: () => void; const catalogEntered = new Promise<void>((resolve) => { entered = resolve; }); fake.entered = entered;
  const mutationCount = () => (fake.frames as [ { command: string } ][]).filter((frame) => frame[0].command !== "schedule.get").length;
  let pending: LegacyCapture["pending"]; let outcome: Outcome; let after: Row;
  try {
    const { handleRoutineScheduleCommand } = await import("./schedules");
    const running = handleRoutineScheduleCommand("update_routine_schedule", {
      schedule_id: before.scheduleId, name: before.name, prompt: before.prompt, cron_pattern: before.cronPattern,
      workspace_root: root, cwd: root, tags: [], enabled: false, ...selection,
    }, root).then((reply) => ({ ok: true, pair: (reply as { schedule: Row }).schedule.modelSelection as Pair }),
      (error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    if (script.delayed) { await catalogEntered; pending = { row: copy(service.getSchedule(before.scheduleId as string)!) as unknown as Row, mutations: mutationCount() }; release?.(); }
    outcome = await running; after = copy(service.getSchedule(before.scheduleId as string)!) as unknown as Row;
  } finally { await service.dispose(); }
  const reopenedService = new RealService(options); let reopened: Row;
  try { reopened = copy(reopenedService.getSchedule(before.scheduleId as string)!) as unknown as Row; }
  finally { await reopenedService.dispose(); }
  assert.equal(fake.runtimeCalls, 0, "Hosted legacy never executes");
  assert.ok(fake.accesses.filter((value) => (value as { kind: string }).kind === "models-read").every((value) =>
    !["cline", "cline-pass", "cline-cloud"].includes((value as { providerId: string }).providerId)), "Hosted legacy never causes hosted catalog discovery");
  const observation = { outcome, before, after, reopened, mutations: mutationCount(), ...(pending ? { pending } : {}) };
  console.log(JSON.stringify({ evidenceKind: "actual baseline SQLite legacy repair; scripted catalogs and inactive runtime", selection, script, observation, frames: fake.frames, accesses: fake.accesses, dbPath: options.dbPath, actualGovernedHost: false }));
  return observation;
}
describe("AC065/066 same complete legacy-repair assertions from independent model to real persistence", () => {
  it("proves correct independent repair model and rejecting interactions first", async () => {
    let controls = 0;
    for (const scenario of legacyCases) {
      assertLegacyRepair(scenario, await independentLegacyRepair(scenario));
      const faults = scenario.accepted ? ["omit-write", "double-write", "wrong-pair", "wrong-result"] as const : [scenario.fault!];
      for (const fault of faults) {
        const bad = await independentLegacyRepair(scenario, fault);
        assert.throws(() => assertLegacyRepair(scenario, bad), assert.AssertionError, "SAME legacy assertions reject " + fault);
        controls++;
      }
    }
    console.log(JSON.stringify({ evidenceKind: "independent input-only legacy repair model", scenarios: legacyCases.length, rejectingControls: controls, failed: 0, skipped: 0 }));
  });
  for (const scenario of legacyCases) it(scenario.name, async () => {
    assertLegacyRepair(scenario, await observeLegacyRepair(scenario.selection, scenario.script));
    if (!scenario.accepted) return;
    const bad = await observeLegacyRepair(scenario.selection, { catalogs: [] });
    assert.throws(() => assertLegacyRepair(scenario, bad), assert.AssertionError, "SAME real-persistence assertions reject missing catalog");
    console.log(JSON.stringify({ evidenceKind: "actual legacy wrong-catalog control", name: scenario.name, rejectedBySameAssertions: true, observation: bad }));
  });
});


function taskOwnedFixtureRoot(env: Record<string, string | undefined>): string {
  const root = env.CLINE_C_ISOLATION_FIXTURE_ROOT ?? env.TMP;
  assert.ok(root, "Checked launcher must provide a synthetic fixture root");
  const normalized = root.replaceAll("\\", "/");
  const ownReceipt = normalized.toLowerCase().startsWith("f:/github/cline/docs/receipts/execution/legion2-20261021t213045/attempt-02/c/") && normalized.endsWith("/temp");
  const nativeOutsideGit = /^F:\/GitHub\/\.qb-c-native-temp-[0-9a-f]{32}$/i.test(normalized)
    && env.CLINE_C_ISOLATION_FIXTURE_ROOT === root && env.TMP === root;
  assert.ok(ownReceipt || nativeOutsideGit, "Only the existing checked C receipt or explicit fresh native fixture producer is supported");
  return root;
}
it("accepts both checked fixture producers and rejects five unrelated or mismatched roots", () => {
  const receipt = "F:/GitHub/cline/docs/receipts/execution/legion2-20261021T213045/attempt-02/C/synthetic/temp";
  const native = "F:/GitHub/.qb-c-native-temp-" + "a".repeat(32);
  assert.equal(taskOwnedFixtureRoot({ TMP: receipt }), receipt);
  assert.equal(taskOwnedFixtureRoot({ TMP: native, CLINE_C_ISOLATION_FIXTURE_ROOT: native }), native);
  for (const env of [{}, { TMP: "F:/unrelated" }, { TMP: native }, { TMP: "F:/different", CLINE_C_ISOLATION_FIXTURE_ROOT: native },
    { TMP: native + "/other", CLINE_C_ISOLATION_FIXTURE_ROOT: native + "/other" }]) {
    assert.throws(() => taskOwnedFixtureRoot(env), assert.AssertionError);
  }
  console.log(JSON.stringify({ evidenceKind: "existing fixture producer contract", correctInputs: 2, rejectingControls: 5 }));
});
// Frozen shared contract was independently proven before this real adapter binding.
import {
  assertActivation, createActivationCases, correctRuntimeResponses, faultyRuntimeResponses,
  observeActivation as captureActivation, runActivationMockGate,
  type ActivationInput, type ActivationCapture, type RuntimeResponses,
} from "./schedule-activation.contract.test-support";

const activationCases = createActivationCases(join(taskOwnedFixtureRoot(process.env), "activation-seed-workspace"));
async function observeRealActivation(input: ActivationInput, responses: RuntimeResponses): Promise<ActivationCapture> {
  vi.resetModules(); fake.script = copy(input.script); fake.journal = []; fake.frames = []; fake.accesses = []; fake.runtimeCalls = 0;
  const fixture = await mkdtemp(join(taskOwnedFixtureRoot(process.env), "sqlite-activation-"));
  await mkdir(input.seed.workspaceRoot, { recursive: true });
  const runtime: Row[] = [];
  const native = {
    startSession: async (request: unknown, options: unknown) => {
      if (responses.start.stopBeforeReturn) await native.stopSession(responses.start.sessionId);
      runtime.push({ kind: "start", request: copy(request), options: copy(options), sessionId: responses.start.sessionId });
      return { sessionId: responses.start.sessionId };
    },
    sendSession: async (id: string, request: unknown) => {
      runtime.push({ kind: "send", sessionId: id, request: copy(request) });
      if (responses.send.error) throw new Error(responses.send.error);
      return { result: copy(responses.send.result) };
    },
    stopSession: async (id: string) => { runtime.push({ kind: "stop", sessionId: id }); return copy(responses.stop); },
    abortSession: async (id: string) => { runtime.push({ kind: "abort", sessionId: id }); return { applied: true }; },
  };
  fake.nativeRuntime = native;
  const { handleRoutineScheduleCommand, createDirectScheduleRuntimeHandlers } = await import("./schedules");
  const publishedEvents: unknown[][] = [];
  const options = { dbPath: join(fixture, "cron.db"), specs: { cronSpecsDir: join(fixture, "specs") },
    runtimeHandlers: createDirectScheduleRuntimeHandlers(), eventPublisher: (...args: unknown[]) => { publishedEvents.push(copy(args)); } };
  const service = new RealService(options); fake.service = service;
  const before = copy(service.createSchedule({ name: "Synthetic activation", prompt: input.seed.prompt, cronPattern: "0 * * * *",
    workspaceRoot: input.seed.workspaceRoot, cwd: input.seed.cwd, enabled: input.enabled,
    modelSelection: copy(input.pair), metadata: copy(input.seed.metadata) as Parameters<RealService["createSchedule"]>[0]["metadata"] })) as unknown as Row;
  let release: (() => void) | undefined; fake.gate = input.script.delayed ? new Promise<void>((resolve) => { release = resolve; }) : undefined;
  let entered!: () => void; const catalogEntered = new Promise<void>((resolve) => { entered = resolve; }); fake.entered = entered;
  emit("input", { host: "hub", operation: input.operation });
  let pending: ActivationCapture["pending"]; let outcome: Outcome; let after: Row; let executions: Row[];
  let routineReply: Row | undefined;
  try {
    const running = handleRoutineScheduleCommand(input.operation + "_routine_schedule",
      { schedule_id: before.scheduleId }, input.seed.workspaceRoot).then((reply) => {
      routineReply = copy(reply) as Row;
      return { ok: true, pair: service.getSchedule(before.scheduleId as string)!.modelSelection as Pair };
    }, (error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    if (input.script.delayed) {
      await catalogEntered; pending = { row: copy(service.getSchedule(before.scheduleId as string)!) as unknown as Row,
        executions: copy(service.listScheduleExecutions({ scheduleId: before.scheduleId as string })) as unknown as Row[],
        runtime: copy(runtime), commands: copy(fake.journal.filter((event) => event.kind === "command")) }; release?.();
    }
    outcome = await running;
    if (outcome.ok && input.operation === "trigger") {
      while (service.getActiveExecutions().length || service.listScheduleExecutions({ scheduleId: before.scheduleId as string })
        .some((execution) => ["pending", "running"].includes(execution.status))) await new Promise<void>((resolve) => setImmediate(resolve));
    }
    after = copy(service.getSchedule(before.scheduleId as string)!) as unknown as Row;
    executions = copy(service.listScheduleExecutions({ scheduleId: before.scheduleId as string })) as unknown as Row[];
  } finally { await service.dispose(); fake.nativeRuntime = undefined; }
  const reopenedService = new RealService({ ...options, runtimeHandlers: runtimeHandlers() });
  let reopened: Row; let reopenedExecutions: Row[];
  try { reopened = copy(reopenedService.getSchedule(before.scheduleId as string)!) as unknown as Row;
    reopenedExecutions = copy(reopenedService.listScheduleExecutions({ scheduleId: before.scheduleId as string })) as unknown as Row[];
  } finally { await reopenedService.dispose(); }
  assert.ok(fake.accesses.filter((effect) => (effect as { kind: string }).kind === "models-read")
    .every((effect) => !["cline", "cline-pass", "cline-cloud"].includes((effect as { providerId: string }).providerId)), "No hosted catalog discovery");
  const observation: ActivationCapture = { outcome, before, after, reopened, executions, reopenedExecutions, runtime: copy(runtime),
    commands: copy(fake.journal.filter((event) => event.kind === "command")), journal: copy(fake.journal),
    routineReply, publishedEvents: copy(publishedEvents), ...(pending ? { pending } : {}) };
  console.log(JSON.stringify({ evidenceKind: "actual baseline SQLite activation and C runtime wrapper; scripted session callbacks",
    input, responses, observation, frames: fake.frames, accesses: fake.accesses, dbPath: options.dbPath,
    actualGovernedHost: false, actualProviderExecution: false }));
  return observation;
}
describe("same activation assertions from independent model to actual queue/runtime-wrapper boundary", () => {
  it("proves all independent activation cases and rejecting effects before binding", async () => {
    const result = await runActivationMockGate(join(taskOwnedFixtureRoot(process.env), "activation-seed-workspace"));
    console.log(JSON.stringify({ evidenceKind: "independent input-only explicit-state activation gate", ...result }));
  });
  for (const scenario of activationCases) it(scenario.name, async () => {
    assertActivation(scenario, await captureActivation(observeRealActivation, scenario.input, correctRuntimeResponses()));
    if (!scenario.admitted) return;
    const missingCatalog = await captureActivation(observeRealActivation, { ...scenario.input, script: { catalogs: [] } }, correctRuntimeResponses());
    assert.throws(() => assertActivation(scenario, missingCatalog), assert.AssertionError);
    console.log(JSON.stringify({ evidenceKind: "actual activation missing-catalog control", name: scenario.name, rejectedBySameAssertions: true, observation: missingCatalog }));
    if (scenario.input.operation !== "trigger") return;
    for (const kind of ["empty-session", "send-error", "early-stop"] as const) {
      const bad = await captureActivation(observeRealActivation, scenario.input, faultyRuntimeResponses(kind));
      if (scenario.input.enabled) {
        assert.throws(() => assertActivation(scenario, bad), assert.AssertionError, "SAME activation assertions reject callback " + kind);
        console.log(JSON.stringify({ evidenceKind: "actual activation callback control", name: scenario.name, fault: kind, rejectedBySameAssertions: true, observation: bad }));
      } else {
        assertActivation(scenario, bad);
        console.log(JSON.stringify({ evidenceKind: "actual disabled callback unused invariant", name: scenario.name, response: kind, observation: bad }));
      }
    }
  });
});

// Actual connector chat handler and private admission. Thread/transport/catalog/store are scripted.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, vi } from "vitest";
import { handleConnectorUserTurn } from "./connector-host";
import { runConnectAdapter } from "../commands/connect";
import type { ConnectRunContext } from "./types";
import { createQbrainScheduleAdmission } from "../commands/schedule/qbrain-admission";
import { readExplicitSchedulePair } from "../../../cline-hub/src/server/qbrain-schedule-admission";
import { assertAdmission, scheduleAdmissionCases, type Observation } from "../qbrain-p1/schedule-admission.contract.test";
import type { Event, Pair, RecordInput, Script } from "../qbrain-p1/schedule-admission.model.test-support";

const fake = vi.hoisted(() => ({
  script: { catalogs: [] } as Script, journal: [] as Event[], accesses: [] as unknown[],
  gate: undefined as Promise<void> | undefined, entered: undefined as (() => void) | undefined,
  receiver: undefined as ((context: ConnectRunContext) => Promise<void>) | undefined,
}));
const copy = <T>(value: T): T => structuredClone(value);
const emit = (kind: string, data: unknown) => fake.journal.push({ kind, data: copy(data) });
vi.mock("./registry", () => ({
  getConnector: async () => ({
    name: "synthetic",
    run: async (_args: string[], _io: unknown, context: ConnectRunContext) => {
      assert.ok(fake.receiver, "Actual connect context receiver exists");
      await fake.receiver(context);
      return 0;
    },
  }),
  listConnectors: () => [],
}));
vi.mock("./hooks", () => ({
  authorizeConnectorEvent: async () => ({ action: "allow" }), dispatchConnectorHook: async () => undefined,
}));
vi.mock("@cline/core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@cline/core")>(),
  ProviderSettingsManager: class {
    read() { return { providers: Object.fromEntries(fake.script.catalogs.map((entry) => [entry.providerId, entry.enabled ? { settings: {} } : {}])) }; }
    getLastUsedProviderSettings() { throw new Error("No inferred explicit provenance"); }
  },
  ensureCustomProvidersLoaded: async () => {
    if (fake.gate) await fake.gate;
    if (fake.script.error) throw new Error(fake.script.error);
  },
  Llms: {
    getProviderIds: () => [...fake.script.catalogs.map((entry) => entry.providerId), "cline", "cline-pass", "cline-cloud"],
    getModelsForProvider: async (providerId: string) => {
      fake.accesses.push({ kind: "models-read", providerId });
      return Object.fromEntries((fake.script.catalogs.find((entry) => entry.providerId === providerId)?.models ?? []).map((id) => [id, { id }]));
    },
  },
}));
vi.mock("../../../cline-hub/src/server/qbrain-schedule-catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../cline-hub/src/server/qbrain-schedule-catalog")>();
  return { ...actual, readRegisteredScheduleCatalog: async (...args: Parameters<typeof actual.readRegisteredScheduleCatalog>) => {
    emit("catalog-request", { providerId: args[0] }); fake.entered?.();
    try { const result = await actual.readRegisteredScheduleCatalog(...args); emit("catalog-response", result); return result; }
    catch (error) { emit("catalog-error", (error as Error).message); throw error; }
  } };
});
const selected = scheduleAdmissionCases.filter((scenario) => scenario.input.host === "cli" && (
  (scenario.input.operation === "create" && !scenario.name.includes("remembered") && !scenario.name.includes("malformed-callback"))
  || scenario.input.operation === "trigger"
));
function pairFrom(record: RecordInput | undefined): Pair {
  const raw = record ?? {};
  return copy((Object.prototype.hasOwnProperty.call(raw, "modelSelection") ? raw.modelSelection : {
    providerId: raw.providerId ?? raw.provider, modelId: raw.modelId ?? raw.model,
  }) as Pair);
}
async function observe(scenario: typeof selected[number], script: Script = scenario.script): Promise<Observation> {
  const input = copy(scenario.input);
  fake.script = copy(script); fake.journal = []; fake.accesses = [];
  let stored = copy(input.stored);
  let submitted: Pair | undefined;
  let release: (() => void) | undefined;
  fake.gate = script.delayed ? new Promise<void>((resolve) => { release = resolve; }) : undefined;
  let entered!: () => void;
  const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
  fake.entered = entered;
  const directory = mkdtempSync(join(tmpdir(), "qb-c15-connector-"));
  let threadState: Record<string, unknown> = { welcomeSentAt: "synthetic", participantKey: "synthetic:user" };
  const posts: string[] = [];
  const payloads: unknown[] = [];
  const thread = {
    id: "synthetic-thread", channelId: "synthetic-channel", isDM: true,
    get state() { return Promise.resolve(copy(threadState)); },
    setState: async (state: Record<string, unknown>) => { threadState = copy(state); },
    post: async (value: unknown) => { posts.push(typeof value === "string" ? value : String(value)); return { edit: async () => undefined }; },
    toJSON: () => ({ id: "synthetic-thread", channelId: "synthetic-channel", isDM: true, state: copy(threadState) }),
  };
  const client = {
    getSchedule: async () => { emit("read", stored); return copy(stored); },
    createSchedule: async (payload: Record<string, unknown>) => {
      submitted = { providerId: payload.provider as string, modelId: payload.model as string };
      payloads.push(copy(payload)); emit("command", { operation: "create", pair: submitted });
      stored = { ...stored, modelSelection: copy(submitted) };
      return { scheduleId: "synthetic-schedule", name: payload.name, cronPattern: payload.cronPattern, ...copy(stored) };
    },
    triggerScheduleNow: async (id: string) => {
      submitted = pairFrom(stored); payloads.push({ id });
      emit("command", { operation: "trigger", pair: submitted }); emit("activate", { operation: "trigger", pair: submitted });
      return { executionId: "synthetic-execution", status: "queued" };
    },
  };
  const admission = createQbrainScheduleAdmission();
  emit("input", { host: input.host, operation: input.operation });
  let failure: Error | undefined;
  const runTurn = (context: ConnectRunContext) => handleConnectorUserTurn({
    thread: thread as never, text: input.operation === "create"
      ? '/schedule create "Synthetic" --cron "0 * * * *" --prompt "Synthetic prompt"'
      : "/schedule trigger synthetic-schedule",
    client: client as never, pendingApprovals: new Map(),
    // Deliberately complete effective runtime defaults must never repair partial raw schedule selection.
    baseStartRequest: { provider: "direct-b", model: "model-b", cwd: directory, workspaceRoot: directory, mode: "act", enableTools: false, systemPrompt: "synthetic" } as never,
    scheduleSelection: input.selection,
    scheduleAdmission: context.scheduleAdmission,
    explicitSystemPrompt: undefined, clientId: "synthetic-client", transport: "synthetic",
    logger: { core: { debug: () => undefined, log: () => undefined, error: () => undefined } } as never,
    requestStop: () => { throw new Error("No connector stop expected"); },
    bindingsPath: join(directory, "bindings.json"), systemRules: "", errorLabel: "Synthetic",
    getSessionMetadata: () => ({}), reusedLogMessage: "synthetic",
  } as Parameters<typeof handleConnectorUserTurn>[0]);
  fake.receiver = runTurn;
  const running = runConnectAdapter("synthetic", ["-i"], { writeln: () => undefined, writeErr: () => undefined }, {
    resolve: async (raw: unknown) => {
      try { emit("selection", readExplicitSchedulePair(raw)); } catch { /* Actual policy owns diagnostic. */ }
      return admission.resolve(raw);
    },
  }).then((code) => assert.equal(code, 0)).catch((error: unknown) => {
    failure = error instanceof Error ? error : new Error(String(error));
  });
  let pending: Observation["pending"];
  if (script.delayed) { await enteredPromise; pending = { journal: copy(fake.journal), stored: copy(stored) }; release?.(); }
  await running;
  const success = posts.some((text) => text.includes('Scheduled "Synthetic".') || text.includes("Triggered schedule synthetic-schedule."));
  const outcome = success && !failure ? { ok: true, pair: submitted } : { ok: false, error: failure?.message ?? posts.join("\n") };
  emit("result", outcome);
  const observation = { outcome, journal: copy(fake.journal), before: copy(input.stored), after: copy(stored), ...(pending ? { pending } : {}) };
  assert.deepEqual(scenario.input, input);
  assert.ok(fake.accesses.every((value) => !["cline", "cline-pass", "cline-cloud"].includes((value as { providerId: string }).providerId)), "No hosted catalog read");
  console.log(JSON.stringify({ evidenceKind: "actual connector chat handler/private admission; scripted thread, registry, client and store", name: scenario.name, observation, payloads, accesses: fake.accesses, actualGovernedHost: false }));
  return observation;
}
for (const scenario of selected) it("connector:" + scenario.name, async () => {
  assertAdmission(scenario, await observe(scenario));
  if (scenario.expected.ok) for (const [name, script] of [
    ["wrong-catalog", { ...scenario.script, catalogs: [{ providerId: "wrong", enabled: true, models: ["wrong"] }] }],
    ["empty-catalog", { ...scenario.script, catalogs: [] }],
    ["failed-catalog", { ...scenario.script, error: "wrong-response-error" }],
  ] satisfies [string, Script][]) {
    const bad = await observe(scenario, script);
    assert.throws(() => assertAdmission(scenario, bad), assert.AssertionError);
    console.log(JSON.stringify({ name: scenario.name, control: name, rejectedBySameAssertions: true }));
  }
});

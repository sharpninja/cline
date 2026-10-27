import assert, { AssertionError } from "node:assert/strict";
import { independentHostModel, type AdmissionInput, type Catalog, type Event, type Factory, type Fault, type Pair, type RecordInput, type Script } from "./schedule-admission.model.test-support";

const direct: Pair = { providerId: "direct-a", modelId: "model-a" };
const other: Pair = { providerId: "direct-b", modelId: "model-b" };
const catalogs: Catalog[] = [
  { providerId: direct.providerId, enabled: true, models: [direct.modelId] },
  { providerId: other.providerId, enabled: true, models: [other.modelId] },
];
interface Case {
  name: string;
  requirements: string[];
  input: AdmissionInput;
  script: Script;
  expected: { ok: boolean; pair?: Pair; selected?: Pair; catalog?: boolean; unchanged?: boolean; diagnostic?: RegExp };
  faults: Fault[];
}
const clone = <T>(value: T): T => structuredClone(value);
const cases: Case[] = [];
function add(name: string, input: Omit<AdmissionInput, "host">, expected: Case["expected"], script: Script = { catalogs }, faults: Fault[] = []): void {
  for (const host of ["cli", "hub"] as const) {
    cases.push({
      name: host + ":" + name, input: { ...clone(input), host }, script: clone(script),
      expected: { ...expected }, faults,
      requirements: [
        "FR-QB-006",
        ...(input.operation === "create" || input.operation === "import" || name.includes("catalog") || name.includes("replacement") || name.includes("preserve-stored") ? ["AC-QB-064", "TEST-QB-064"] : []),
        ...(name.includes("legacy") || name.includes("replacement") ? ["AC-QB-065", "TEST-QB-065"] : []),
        ...(name.includes("structured") || name.includes("malformed") || name.includes("legacy-absent") ? ["AC-QB-066", "TEST-QB-066"] : []),
        ...(name.includes("forbidden-alias") || name.includes("legacy-hosted-blocked") ? ["AC-QB-016", "AC-QB-017"] : []),
        expected.ok && !expected.diagnostic ? "UC-QB-005.flow-9.step-35" : "UC-QB-005.flow-10.step-36",
      ],
    });
  }
}
const acceptedFaults: Fault[] = ["write-before-catalog", "omit-write", "double-write", "wrong-pair", "wrong-result", "omit-catalog"];
const selected = { ok: true, pair: direct, selected: direct, catalog: true };
const selectionError = { ok: false, diagnostic: /Select both|Repair modelSelection/ };
const catalogError = { ok: false, selected: direct, catalog: true, diagnostic: /catalog|Catalog|Settings/ };
const storedDirect = { id: "synthetic-schedule", enabled: false, modelSelection: direct, canary: "retained-original" };
for (const operation of ["create", "import"] as const) {
  add(operation + ":explicit-direct", { operation, selection: { provider: " direct-a ", model: " model-a " } }, selected, { catalogs }, acceptedFaults);
  add(operation + ":remembered-explicit-complete", { operation, remembered: { explicit: true, pair: direct } }, selected, { catalogs }, acceptedFaults);
  add(operation + ":remembered-not-explicit", { operation, remembered: { explicit: false, pair: direct } }, selectionError);
  add(operation + ":no-selection", { operation }, selectionError);
  add(operation + ":provider-only-no-borrow", { operation, selection: { provider: direct.providerId }, remembered: { explicit: true, pair: direct } }, selectionError, { catalogs }, ["partial-borrow", "first-model"]);
  add(operation + ":model-only-no-borrow", { operation, selection: { model: direct.modelId }, remembered: { explicit: true, pair: direct } }, selectionError, { catalogs }, ["partial-borrow"]);
  add(operation + ":missing-model-not-first-catalog", { operation, selection: { provider: direct.providerId } }, selectionError, { catalogs }, ["first-model"]);
  add(operation + ":remembered-stale-catalog", { operation, remembered: { explicit: true, pair: direct } }, catalogError, { catalogs: [] });
}
for (const malformed of [null, [], "bad", {}, { providerId: "direct-a" }, { modelId: "model-a" }, { providerId: "direct-a", modelId: "" }, { providerId: 5, modelId: "model-a" }]) {
  const index = cases.length;
  add("import:authoritative-malformed-" + index, {
    operation: "import", selection: { modelSelection: malformed, providerId: "direct-a", modelId: "model-a" },
  }, selectionError, { catalogs }, ["scalar-borrow"]);
}
add("import:structured-wins-as-unit", { operation: "import", selection: { modelSelection: direct, provider: "cline", model: "hosted-old" } }, selected, { catalogs }, acceptedFaults);
add("import:absent-structured-legacy-direct", { operation: "import", selection: { providerId: "direct-a", modelId: "model-a" } }, selected, { catalogs }, acceptedFaults);
for (const operation of ["update", "resume", "trigger"] as const) {
  add(operation + ":preserve-stored-complete", { operation, stored: storedDirect }, selected, { catalogs }, acceptedFaults);
  add(operation + ":legacy-scalar-complete", { operation, stored: { ...storedDirect, modelSelection: undefined, provider: "direct-a", model: "model-a" } }, selectionError);
  // A genuinely absent field differs from an explicitly present undefined field.
  add(operation + ":legacy-absent-structured", { operation, stored: { id: "synthetic-schedule", provider: "direct-a", model: "model-a", canary: "retained-original" } }, selected, { catalogs }, acceptedFaults);
  const hosted: Pair = { providerId: "cline", modelId: "hosted-old" };
  add(operation + ":legacy-hosted-blocked", { operation, stored: { id: "synthetic-schedule", modelSelection: hosted, canary: "retained-original" } }, {
    ok: false, selected: hosted, diagnostic: /direct provider|hosted/,
  }, { catalogs: [...catalogs, { providerId: "cline", enabled: true, models: ["hosted-old"] }] }, ["allow-hosted"]);
  add(operation + ":stale-stored-catalog", { operation, stored: storedDirect }, catalogError, { catalogs: [{ providerId: "direct-a", enabled: true, models: ["different"] }] });
}
add("update:legacy-explicit-direct-replacement", { operation: "update", stored: { id: "synthetic-schedule", provider: "cline", model: "hosted-old", canary: "retained-original" }, selection: { modelSelection: direct } }, selected, { catalogs }, acceptedFaults);
add("update:failed-replacement-retains-legacy", { operation: "update", stored: { id: "synthetic-schedule", provider: "cline", model: "hosted-old", canary: "retained-original" }, selection: { modelSelection: direct } }, catalogError, { catalogs: [] });
for (const operation of ["open", "cancel"] as const) {
  add(operation + ":legacy-no-activation-or-rewrite", { operation, stored: { provider: "cline", model: "hosted-old", canary: "retained-original" } }, { ok: true, unchanged: true, diagnostic: /direct provider/ }, { catalogs }, ["activate-on-open", "false-unchanged"]);
  add(operation + ":malformed-no-scalar-repair", { operation, stored: { modelSelection: null, provider: "direct-a", model: "model-a", canary: "retained-original" } }, { ok: true, unchanged: true, diagnostic: /Repair modelSelection/ }, { catalogs }, ["activate-on-open", "false-unchanged", "scalar-borrow"]);
  add(operation + ":direct-preserved", { operation, stored: storedDirect }, { ok: true, unchanged: true }, { catalogs }, ["activate-on-open", "false-unchanged"]);
}
for (const alias of ["cline", "CLINE-PASS", " cline-cloud "]) {
  const pair = { providerId: alias.trim(), modelId: "hosted-old" };
  add("create:forbidden-alias-" + alias.trim(), { operation: "create", selection: { provider: alias, model: "hosted-old" } }, { ok: false, selected: pair, diagnostic: /direct provider|hosted/ }, {
    catalogs: [{ providerId: pair.providerId, enabled: true, models: ["hosted-old"] }],
  }, ["allow-hosted"]);
}
for (const operation of ["create", "update"] as const) {
  const input = { operation, selection: { modelSelection: direct }, ...(operation === "update" ? { stored: storedDirect } : {}) };
  add(operation + ":catalog-empty", input, catalogError, { catalogs: [] });
  add(operation + ":catalog-disabled", input, catalogError, { catalogs: [{ providerId: "direct-a", enabled: false, models: ["model-a"] }] }, ["ignore-enabled"]);
  add(operation + ":catalog-cross-provider-model", input, catalogError, { catalogs: [{ providerId: "direct-a", enabled: true, models: [] }, { providerId: "direct-b", enabled: true, models: ["model-a"] }] }, ["cross-catalog"]);
  add(operation + ":catalog-failed", input, catalogError, { catalogs, error: "synthetic catalog failure" }, ["swallow-error"]);
  add(operation + ":catalog-delayed-valid", input, selected, { catalogs, delayed: true }, [...acceptedFaults, "write-while-pending", "reorder-response"]);
  add(operation + ":catalog-delayed-empty", input, catalogError, { catalogs: [], delayed: true }, ["write-while-pending", "reorder-response"]);
  add(operation + ":catalog-delayed-failed", input, catalogError, { catalogs, delayed: true, error: "synthetic catalog failure" }, ["write-while-pending", "reorder-response", "swallow-error"]);
}
// Additive runtime callback cases. The original 132 scenarios and all assertions remain unchanged.
for (const [index, malformed] of [
  null, undefined, {}, "catalog", [null], [{ providerId: "direct-a", enabled: "false", models: ["model-a"] }],
  [{ providerId: "direct-a", enabled: true, models: "model-a" }],
  [{ providerId: "direct-a", enabled: true, models: [17] }],
  [{ providerId: 17, enabled: true, models: ["model-a"] }],
  [{ providerId: "direct-a", enabled: true, models: [""] }],
].entries()) {
  add("create:catalog-malformed-callback-" + index, {
    operation: "create", selection: { provider: "direct-a", model: "model-a" },
  }, catalogError, { catalogs: malformed as unknown as Catalog[] }, ["accept-malformed-catalog"]);
}
export interface Observation {
  outcome: unknown;
  journal: Event[];
  before: RecordInput | undefined;
  after: RecordInput | undefined;
  pending?: { journal: Event[]; stored: RecordInput | undefined };
}
async function observe(factory: Factory, scenario: Case, fault: Fault = "none", script = scenario.script): Promise<Observation> {
  const originalInput = clone(scenario.input);
  const originalScript = clone(script);
  const run = factory(clone(originalInput), clone(originalScript), fault);
  let pending: Observation["pending"];
  if (script.delayed) {
    await Promise.resolve();
    pending = { journal: clone(run.journal), stored: run.snapshot() };
    run.settle();
  }
  const outcome = await run.result;
  assert.deepStrictEqual(scenario.input, originalInput, "model must not mutate caller input");
  assert.deepStrictEqual(script, originalScript, "model must not mutate dependency script");
  return { outcome, journal: clone(run.journal), before: clone(originalInput.stored), after: run.snapshot(), ...(pending ? { pending } : {}) };
}
// This assertion function is the sole contract for Mock and later real host adapters.
export function assertAdmission(scenario: Case, observed: Observation): void {
  const expected = scenario.expected;
  const actual = observed.outcome as { ok: boolean; pair?: Pair; error?: string; unchanged?: boolean };
  assert.equal(actual.ok, expected.ok, "admission outcome");
  assert.deepStrictEqual(actual.pair, expected.pair, "returned complete exact pair");
  assert.equal(actual.unchanged, expected.unchanged, "unchanged acknowledgment");
  if (expected.diagnostic) assert.match(actual.error ?? "", expected.diagnostic, "actionable diagnostic");
  else assert.equal(actual.error, undefined, "no unexpected diagnostic");
  const kinds = ["input"];
  if (scenario.input.stored !== undefined) kinds.push("read");
  if (expected.selected) kinds.push("selection");
  if (expected.catalog) kinds.push("catalog-request", scenario.script.error ? "catalog-error" : "catalog-response");
  if (expected.ok && !expected.unchanged) {
    kinds.push("command");
    if (scenario.input.operation === "resume" || scenario.input.operation === "trigger") kinds.push("activate");
  }
  kinds.push("result");
  assert.deepStrictEqual(observed.journal.map((event) => event.kind), kinds, "exact effects and order");
  assert.deepStrictEqual(observed.journal[0], { kind: "input", data: { host: scenario.input.host, operation: scenario.input.operation } }, "captured host and operation");
  for (const event of observed.journal) {
    if (event.kind === "read") assert.deepStrictEqual(event.data, scenario.input.stored, "exact stored input");
    if (event.kind === "selection") assert.deepStrictEqual(event.data, expected.selected, "selected pair as unit");
    if (event.kind === "catalog-request") assert.deepStrictEqual(event.data, { providerId: expected.selected!.providerId }, "catalog requested for same provider");
    if (event.kind === "catalog-response") assert.deepStrictEqual(event.data, scenario.script.catalogs, "exact scripted response");
    if (event.kind === "catalog-error") assert.equal(event.data, scenario.script.error, "exact catalog failure");
    if (event.kind === "command" || event.kind === "activate") assert.deepStrictEqual(event.data, { operation: scenario.input.operation, pair: expected.pair }, "exact effect payload");
    if (event.kind === "result") assert.deepStrictEqual(event.data, observed.outcome, "published result matches returned result");
  }
  const next = !expected.ok || expected.unchanged || scenario.input.operation === "trigger"
    ? scenario.input.stored
    : scenario.input.operation === "resume"
      ? { ...(scenario.input.stored ?? {}), enabled: true }
      : { ...(scenario.input.stored ?? {}), modelSelection: expected.pair };
  assert.deepStrictEqual(observed.after, next, "complete persistent snapshot");
  if (scenario.script.delayed) {
    assert.ok(observed.pending, "actual pending observation");
    assert.deepStrictEqual(observed.pending.stored, scenario.input.stored, "no mutation while catalog pending");
    assert.deepStrictEqual(observed.pending.journal.map((event) => event.kind), kinds.slice(0, kinds.indexOf("catalog-request") + 1), "no response, write, activation or result before catalog settles");
  }
}
export async function runAdmissionContract(factory: Factory) {
  const evidence: unknown[] = [];
  let controls = 0;
  for (const scenario of cases) {
    const observation = await observe(factory, scenario);
    assertAdmission(scenario, observation);
    evidence.push({ name: scenario.name, requirements: scenario.requirements, kind: "correct", observation });
    const controlsForCase: { name: string; fault?: Fault; script?: Script }[] = scenario.faults.map((fault) => ({ name: fault, fault }));
    if (scenario.expected.ok && !scenario.expected.unchanged) {
      controlsForCase.push(
        { name: "dependency-wrong-provider-response", script: { ...scenario.script, catalogs: [{ providerId: "wrong", enabled: true, models: ["wrong"] }] } },
        { name: "dependency-missing-catalog-response", script: { ...scenario.script, catalogs: [] } },
        { name: "dependency-error-response", script: { ...scenario.script, error: "wrong-response-error" } },
      );
    }
    for (const control of controlsForCase) {
      const bad = await observe(factory, scenario, control.fault ?? "none", control.script ?? scenario.script);
      let rejection: string | undefined;
      try { assertAdmission(scenario, bad); } catch (error) {
        if (!(error instanceof AssertionError)) throw error;
        rejection = error.message;
      }
      assert.ok(rejection, scenario.name + ": control was not rejected: " + control.name);
      controls++;
      evidence.push({ name: scenario.name, kind: "rejecting-control", control: control.name, rejectedBySameAssertions: true, rejection, observation: bad });
    }
  }
  return { scenarios: cases.length, passed: cases.length, rejectingControls: controls, failed: 0, skipped: 0, evidenceKind: "independent test-only host admission model", productionBound: false, actualGovernedHost: false, evidence };
}
if (import.meta.main) {
  runAdmissionContract(independentHostModel).then(
    (proof) => process.stdout.write(JSON.stringify(proof)),
    (error) => { console.error(error); process.exitCode = 1; },
  );
}

// Read-only test adapter access. Case inputs and assertions remain defined once above.
export const scheduleAdmissionCases: readonly Case[] = cases;


// Register the same independent prerequisite in package discovery as well as the standalone gate.
// Importing the shared assertions does not turn this modeled case into host evidence.
if (!import.meta.main && process.env.VITEST) {
  const { it } = await import("vitest");
  it("independent schedule admission prerequisite: same152 scenarios and402 rejecting controls, preserving original132/382", async () => {
    await runAdmissionContract(independentHostModel);
  });
}


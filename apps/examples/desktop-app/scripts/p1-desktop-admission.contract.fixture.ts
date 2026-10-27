// SPDX-License-Identifier: Apache-2.0
// Test-only host seam. No SDK protocol, discovery, credentials or production import.
import assert from "node:assert/strict";
export type Pair = { providerId: string; modelId: string };
export type Operation = {
  kind: "create" | "edit" | "onboard" | "recover" | "cancel";
  raw: Record<string, unknown>;
  context: string;
  rememberedExplicit?: boolean;
  hostedHistory?: boolean;
  explicitNewSession?: boolean;
  target?: "local" | "cloud";
};
export type CatalogReply = {
  status: "ready" | "pending" | "error";
  context: string;
  providers: { id: string; enabled: boolean; models: string[]; keyOnly?: boolean }[];
};
export type Effect = { kind: string; value: unknown };
export type Dependencies = {
  catalog(): Promise<CatalogReply>;
  save(pair: Pair): Promise<boolean>;
  commit(kind: Operation["kind"], pair: Pair, context: string): Promise<void>;
  advance(): void;
  diagnose(message: string): void;
};
export type Provider = (input: Operation, dependencies: Dependencies) => Promise<void>;
export type Scenario = {
  name: string;
  ac: string[];
  input: Operation;
  catalog: CatalogReply;
  saveOk?: boolean;
  expected: { effects: Effect[]; pair: Pair | null; advances: number; diagnostic: boolean };
  rejects: string[];
};
export const pair: Pair = { providerId: "direct-a", modelId: "model-a" };
export const ready: CatalogReply = {
  status: "ready", context: "ctx-a",
  providers: [
    { id: "direct-a", enabled: true, models: ["model-a", "model-a2"], keyOnly: true },
    { id: "direct-b", enabled: true, models: ["model-b"], keyOnly: true },
  ],
};
export const catalogEffect: Effect = { kind: "catalog", value: null };
const commitEffect = (kind: Operation["kind"], p = pair): Effect => ({ kind: "commit", value: { kind, pair: p, context: "ctx-a" } });
export const scenarios: Scenario[] = [];
function add(name: string, input: Operation, catalog: CatalogReply, accepted: boolean, rejects: string[], options: { saveOk?: boolean; ac?: string[]; selected?: Pair } = {}) {
  const p = options.selected ?? pair;
  const effects: Effect[] = input.kind === "cancel" || input.target === "cloud" ? [] : [catalogEffect];
  if (input.kind === "onboard" && accepted) effects.push({ kind: "save", value: p });
  if (accepted && options.saveOk !== false) {
    effects.push(commitEffect(input.kind, p));
    if (input.kind === "onboard") effects.push({ kind: "advance", value: null });
  }
  const success = accepted && options.saveOk !== false;
  scenarios.push({ name, input, catalog, saveOk: options.saveOk,
    ac: options.ac ?? ["AC-QB-063", "AC-QB-064", "AC-QB-065", "AC-QB-066"],
    expected: { effects, pair: success ? p : null, advances: success && input.kind === "onboard" ? 1 : 0, diagnostic: !success && input.kind !== "cancel" }, rejects });
}
const op = (kind: Operation["kind"], raw: Record<string, unknown> = { provider: "direct-a", model: "model-a" }): Operation => ({ kind, raw, context: "ctx-a" });
const goodFaults = ["omit-commit", "duplicate-commit", "wrong-pair", "wrong-context", "commit-before-catalog"];
for (const kind of ["create", "edit", "recover"] as const) {
  add(`${kind}: exact explicit legacy pair`, { ...op(kind), explicitNewSession: true }, ready, true, goodFaults);
  add(`${kind}: authoritative structured pair`, { ...op(kind, { modelSelection: pair, provider: "direct-b", model: "model-b" }), explicitNewSession: true }, ready, true, goodFaults);
  for (const value of [null, false, [], "direct-a", {}, { providerId: "direct-a" }, { modelId: "model-a" }, { providerId: 7, modelId: "model-a" }]) {
    add(`${kind}: malformed structured ${JSON.stringify(value)}`, op(kind, { modelSelection: value, provider: "direct-a", model: "model-a" }), ready, false, ["borrow-legacy", "mutate-blocked"]);
  }
  for (const raw of [{ provider: "direct-a" }, { model: "model-a" }, {}, { provider: "direct-a", model: "model-b" }, { provider: "direct-a", model: "removed-model" }]) {
    add(`${kind}: incomplete or stale ${JSON.stringify(raw)}`, op(kind, raw), ready, false, ["accept-invalid-pair", "mutate-blocked"]);
  }
}
for (const alias of ["cline", "cline-pass", "cline-cloud", " CLINE ", "CLINE-PASS"]) {
  add(`hosted alias ${alias} cannot be enabled by stale catalog`, op("edit", { provider: alias, model: "hosted" }), { ...ready, providers: [{ id: alias.trim(), enabled: true, models: ["hosted"], keyOnly: true }] }, false, ["allow-hosted", "mutate-blocked"], { ac: ["AC-QB-061", "AC-QB-063", "AC-QB-065"] });
}
for (const status of ["pending", "error"] as const) add(`catalog ${status} has no fallback`, op("create"), { ...ready, status }, false, ["ignore-catalog-state", "mutate-blocked"]);
add("empty catalog cannot synthesize selection", op("create"), { ...ready, providers: [] }, false, ["accept-invalid-pair", "mutate-blocked"]);
add("disabled provider cannot be enabled by editing stored pair", op("edit"), { ...ready, providers: [{ id: "direct-a", enabled: false, models: ["model-a"] }] }, false, ["accept-invalid-pair", "mutate-blocked"]);
add("catalog refresh removes selected model", op("edit"), { ...ready, providers: [{ id: "direct-a", enabled: true, models: ["model-a2"] }] }, false, ["accept-invalid-pair", "mutate-blocked"]);
add("late old-context catalog cannot commit replacement context", op("create"), { ...ready, context: "ctx-b" }, false, ["ignore-context", "mutate-blocked"], { ac: ["AC-QB-063", "AC-QB-064", "AC-QB-072"] });
add("remembered pair lacks explicit provenance", { ...op("create"), rememberedExplicit: false }, ready, false, ["invent-provenance", "mutate-blocked"]);
add("previously explicit remembered pair remains exact", { ...op("create"), rememberedExplicit: true }, ready, true, goodFaults);
add("onboarding compatible key-only save precedes advance", op("onboard"), ready, true, [...goodFaults, "advance-before-save", "omit-save"], { ac: ["AC-QB-061", "AC-QB-062"] });
add("onboarding failed save cannot advance or select fallback", op("onboard"), ready, true, ["ignore-save-failure", "advance-before-save"], { saveOk: false, ac: ["AC-QB-062"] });
add("onboarding alternate authentication belongs in Settings", op("onboard"), { ...ready, providers: [{ id: "direct-a", enabled: true, models: ["model-a"], keyOnly: false }] }, false, ["ignore-form-compatibility", "mutate-blocked"], { ac: ["AC-QB-062"] });
add("hosted target rejection forbids selection commit", { ...op("recover"), target: "cloud", hostedHistory: true }, ready, false, ["allow-hosted-target", "mutate-blocked"], { ac: ["AC-QB-067"] });
add("hosted history needs explicit new session", { ...op("recover"), hostedHistory: true }, ready, false, ["reinterpret-history", "mutate-blocked"], { ac: ["AC-QB-067"] });
add("explicit new local recovery uses exact permitted pair", { ...op("recover"), hostedHistory: true, explicitNewSession: true }, ready, true, goodFaults, { ac: ["AC-QB-067"] });
add("cancel legacy hosted edit is inert", op("cancel", { provider: "cline", model: "hosted" }), ready, false, ["mutate-cancel"], { ac: ["AC-QB-065"] });
add("onboarding may explicitly configure a compatible disabled provider", op("onboard"), { ...ready, providers: [{ id: "direct-a", enabled: false, models: ["model-a"], keyOnly: true }] }, true, goodFaults, { ac: ["AC-QB-062"] });
for (const malformed of [null, {}, { status: "ready", context: "ctx-a", providers: null }, { ...ready, providers: [{ id: "direct-a", enabled: "true", models: ["model-a"] }] }, { ...ready, providers: [{ id: "direct-a", enabled: true, models: [7] }] }]) {
  add(`malformed catalog response ${JSON.stringify(malformed)}`, op("create"), malformed as unknown as CatalogReply, false, ["accept-malformed-catalog", "mutate-blocked"], { ac: ["AC-QB-063", "AC-QB-064"] });
}


// The runner owns expectation and dependency effects. The provider receives no scenario name or expected result.
export async function runScenario(scenario: Scenario, provider: Provider, dependencyDefect = "none") {
  const effects: Effect[] = [];
  let stored: Pair | null = null;
  let advances = 0;
  const diagnostics: string[] = [];
  const dependencies: Dependencies = {
    catalog: async () => {
      effects.push({ kind: "catalog", value: null });
      if (dependencyDefect === "missing-catalog-response") return null as unknown as CatalogReply;
      const response = structuredClone(scenario.catalog);
      if (dependencyDefect === "wrong-context-response") response.context = "ctx-replaced";
      if (dependencyDefect === "disabled-provider-response") response.providers = response.providers.map((p) => ({ ...p, enabled: false }));
      if (dependencyDefect === "wrong-model-response") response.providers = response.providers.map((p) => ({ ...p, models: ["unrequested-model"] }));
      return response;
    },
    save: async (p) => { effects.push({ kind: "save", value: structuredClone(p) }); return scenario.saveOk !== false; },
    commit: async (kind, p, context) => { if (dependencyDefect === "missing-commit-callback") return; effects.push({ kind: "commit", value: { kind, pair: structuredClone(p), context } }); stored = structuredClone(p); },
    advance: () => { effects.push({ kind: "advance", value: null }); advances++; },
    diagnose: (message) => { diagnostics.push(message); },
  };
  await provider(structuredClone(scenario.input), dependencies);
  return { effects, stored, advances, diagnostics };
}
export function assertScenario(scenario: Scenario, observed: Awaited<ReturnType<typeof runScenario>>) {
  assert.deepStrictEqual(observed.effects, scenario.expected.effects);
  assert.deepStrictEqual(observed.stored, scenario.expected.pair);
  assert.equal(observed.advances, scenario.expected.advances);
  assert.equal(observed.diagnostics.length > 0, scenario.expected.diagnostic);
  for (const message of observed.diagnostics) assert.match(message, /Settings|direct|select|catalog|session/i);
}

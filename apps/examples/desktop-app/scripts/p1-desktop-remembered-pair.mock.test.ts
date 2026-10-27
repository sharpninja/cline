// SPDX-License-Identifier: Apache-2.0
// AC-QB-064: remembered provenance never substitutes for current catalog agreement.
// Supplement only: frozen D03/D04 cases and assertions remain unchanged.
import { expect, test } from "bun:test";
import {
  assertScenario, pair, ready, runScenario,
  type CatalogReply, type Operation, type Scenario,
} from "./p1-desktop-admission.contract.fixture";
import { createAdmissionModel } from "./p1-desktop-admission.model.fixture";

const operation = (raw: Record<string, unknown> = { provider: "direct-a", model: "model-a" }): Operation => ({
  kind: "create", raw, context: "ctx-a", rememberedExplicit: true,
});
function scenario(name: string, input: Operation, catalog: CatalogReply, accepted: boolean, rejects: string[]): Scenario {
  return {
    name: `remembered explicit pair: ${name}`,
    ac: ["AC-QB-064"], input, catalog, rejects,
    expected: {
      effects: accepted ? [
        { kind: "catalog", value: null },
        { kind: "commit", value: { kind: "create", pair, context: "ctx-a" } },
      ] : [{ kind: "catalog", value: null }],
      pair: accepted ? pair : null, advances: 0, diagnostic: !accepted,
    },
  };
}
const invalidPair = ["accept-invalid-pair", "mutate-blocked"];
export const rememberedPairScenarios: Scenario[] = [
  scenario("current enabled same-provider model remains exact", operation(), ready, true,
    ["omit-commit", "duplicate-commit", "wrong-pair", "wrong-context", "commit-before-catalog"]),
  scenario("disabled provider cannot be re-enabled from remembered state", operation(),
    { ...ready, providers: [{ id: "direct-a", enabled: false, models: ["model-a"] }] }, false, invalidPair),
  scenario("removed provider cannot borrow another provider catalog", operation(),
    { ...ready, providers: [{ id: "direct-b", enabled: true, models: ["model-b"] }] }, false, invalidPair),
  scenario("removed model cannot be recreated from remembered state", operation(),
    { ...ready, providers: [{ id: "direct-a", enabled: true, models: ["model-a2"] }] }, false, invalidPair),
  scenario("other-provider model is unavailable for selected provider", operation({ provider: "direct-a", model: "model-b" }), ready, false, invalidPair),
  scenario("partial structured pair cannot borrow valid legacy members", operation({
    modelSelection: { providerId: "direct-a" }, provider: "direct-a", model: "model-a",
  }), ready, false, ["borrow-legacy", "mutate-blocked"]),
  scenario("missing remembered model remains incomplete", operation({ provider: "direct-a" }), ready, false, invalidPair),
  scenario("pending current catalog cannot authorize remembered selection", operation(),
    { ...ready, status: "pending" }, false, ["ignore-catalog-state", "mutate-blocked"]),
  scenario("failed current catalog cannot authorize remembered selection", operation(),
    { ...ready, status: "error" }, false, ["ignore-catalog-state", "mutate-blocked"]),
  scenario("old-context reply cannot authorize current remembered selection", operation(),
    { ...ready, context: "ctx-b" }, false, ["ignore-context", "mutate-blocked"]),
  scenario("empty catalog cannot synthesize remembered provider", operation(),
    { ...ready, providers: [] }, false, invalidPair),
  scenario("malformed enabled value cannot authorize remembered selection", operation(),
    { ...ready, providers: [{ id: "direct-a", enabled: "true", models: ["model-a"] }] } as unknown as CatalogReply,
    false, ["accept-malformed-catalog", "mutate-blocked"]),
];

for (const item of rememberedPairScenarios) {
  test(`${item.name} / independent correct model`, async () => {
    const observed = await runScenario(item, createAdmissionModel());
    assertScenario(item, observed);
    console.log(JSON.stringify({ scenario: item.name, mode: "Mock", observed }));
  });
  for (const defect of item.rejects) {
    test(`${item.name} / SAME assertion rejects actual ${defect} interactions`, async () => {
      const observed = await runScenario(item, createAdmissionModel(defect));
      let rejected = false;
      try { assertScenario(item, observed); } catch { rejected = true; }
      expect(rejected).toBe(true);
      console.log(JSON.stringify({ scenario: item.name, defect, rejected, observed }));
    });
  }
}
for (const dependencyDefect of [
  "missing-catalog-response", "wrong-context-response", "wrong-model-response",
  "missing-commit-callback", "disabled-provider-response",
]) {
  test(`remembered valid pair / SAME assertion rejects scripted ${dependencyDefect}`, async () => {
    const item = rememberedPairScenarios[0]!;
    const observed = await runScenario(item, createAdmissionModel(), dependencyDefect);
    let rejected = false;
    try { assertScenario(item, observed); } catch { rejected = true; }
    expect(rejected).toBe(true);
    console.log(JSON.stringify({ scenario: item.name, dependencyDefect, rejected, observed }));
  });
}
test("remembered-pair inventory preserves twelve cases and twenty-seven interaction controls", () => {
  expect(rememberedPairScenarios.length).toBe(12);
  expect(new Set(rememberedPairScenarios.map((item) => item.name)).size).toBe(12);
  expect(rememberedPairScenarios.reduce((sum, item) => sum + item.rejects.length, 0)).toBe(27);
});

// SPDX-License-Identifier: Apache-2.0
// P1 AC062 requirement-derived supplement: distinguish explicit atomic choice from catalog defaults.
import { ready, catalogEffect, type Operation, type Pair, type Scenario, type CatalogReply } from "./p1-desktop-admission.contract.fixture";
const nondefault: Pair = { providerId: "direct-a", modelId: "model-a2" };
const other: Pair = { providerId: "direct-b", modelId: "model-b" };
const faults = ["omit-commit", "duplicate-commit", "wrong-context", "commit-before-catalog", "advance-before-save", "omit-save"];
const operation = (raw: Record<string, unknown>): Operation => ({ kind: "onboard", raw, context: "ctx-a" });
function define(name: string, input: Operation, catalog: CatalogReply, selected: Pair | null, rejects: string[], saveOk = true): Scenario {
  // Expected order is the approved onboarding contract, independently authored before any UI correction.
  const effects = [catalogEffect];
  if (selected) effects.push({ kind: "save", value: selected });
  if (selected && saveOk) effects.push(
    { kind: "commit", value: { kind: "onboard", pair: selected, context: "ctx-a" } },
    { kind: "advance", value: null },
  );
  return { name, input, catalog, saveOk, ac: ["AC-QB-061", "AC-QB-062", "AC-QB-072"], rejects,
    expected: { effects, pair: selected && saveOk ? selected : null, advances: selected && saveOk ? 1 : 0, diagnostic: !selected || !saveOk } };
}
export const onboardingAtomicScenarios: Scenario[] = [
  define("onboarding atomic: explicit nondefault same-provider model", operation({ modelSelection: nondefault }), ready, nondefault, [...faults, "wrong-pair"]),
  define("onboarding atomic: explicit other provider and its own model", operation({ modelSelection: other }), ready, other, faults),
  define("onboarding atomic: explicitly configure disabled compatible provider with nondefault model",
    operation({ modelSelection: nondefault }), { ...ready, providers: [{ id: "direct-a", enabled: false, models: ["model-a", "model-a2"], keyOnly: true }] },
    nondefault, [...faults, "wrong-pair"]),
  define("onboarding atomic: cannot borrow model from another provider",
    operation({ provider: "direct-a", model: "model-b" }), ready, null, ["accept-invalid-pair", "mutate-blocked"]),
  define("onboarding atomic: malformed structured choice cannot borrow valid legacy pair",
    operation({ modelSelection: null, provider: "direct-a", model: "model-a" }), ready, null, ["borrow-legacy", "accept-invalid-pair", "mutate-blocked"]),
  define("onboarding atomic: structured nondefault choice overrides contradictory legacy pair",
    operation({ modelSelection: nondefault, provider: "direct-b", model: "model-b" }), ready, nondefault, [...faults, "wrong-pair"]),
  define("onboarding atomic: failed nondefault save cannot persist or advance",
    operation({ modelSelection: nondefault }), ready, nondefault, ["ignore-save-failure", "advance-before-save", "omit-save"], false),
  define("onboarding atomic: replaced context cannot save selection",
    operation({ modelSelection: nondefault }), { ...ready, context: "ctx-replaced" }, null, ["ignore-context", "mutate-blocked"]),
];

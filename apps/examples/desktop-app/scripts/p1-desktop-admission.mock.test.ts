// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test";
import { assertScenario, runScenario, scenarios } from "./p1-desktop-admission.contract.fixture";
import { createAdmissionModel } from "./p1-desktop-admission.model.fixture";
for (const scenario of scenarios) {
  test(`${scenario.ac.join("/")} / ${scenario.name} / independent correct model`, async () => {
    const observed = await runScenario(scenario, createAdmissionModel());
    assertScenario(scenario, observed);
    console.log(JSON.stringify({ scenario: scenario.name, mode: "Mock", observed }));
  });
  for (const defect of scenario.rejects) {
    test(`${scenario.name} / SAME assertion rejects actual ${defect} interactions`, async () => {
      const observed = await runScenario(scenario, createAdmissionModel(defect));
      let rejected = false;
      try { assertScenario(scenario, observed); } catch { rejected = true; }
      expect(rejected).toBe(true);
      console.log(JSON.stringify({ scenario: scenario.name, defect, rejected, observed }));
    });
  }
}
test("admission inventory contains no empty negative-control lists or duplicate names", () => {
  expect(new Set(scenarios.map((s) => s.name)).size).toBe(scenarios.length);
  for (const scenario of scenarios) expect(scenario.rejects.length).toBeGreaterThan(0);
});
// Scripted wrong/missing dependency responses and omitted real delivery effects,
// in addition to provider mutants. The assertion path is unchanged.
for (const scenario of scenarios.filter((entry) => entry.expected.pair !== null)) {
  const defects = ["missing-catalog-response", "wrong-context-response", "wrong-model-response", "missing-commit-callback"];
  if (scenario.input.kind !== "onboard") defects.push("disabled-provider-response");
  for (const dependencyDefect of defects) {
    test(`${scenario.name} / SAME assertion rejects scripted ${dependencyDefect}`, async () => {
      const observed = await runScenario(scenario, createAdmissionModel(), dependencyDefect);
      let rejected = false;
      try { assertScenario(scenario, observed); } catch { rejected = true; }
      expect(rejected).toBe(true);
      console.log(JSON.stringify({ scenario: scenario.name, dependencyDefect, rejected, observed }));
    });
  }
}


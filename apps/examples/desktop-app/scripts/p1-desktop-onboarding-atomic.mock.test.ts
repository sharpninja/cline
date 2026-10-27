// SPDX-License-Identifier: Apache-2.0
// New P1 onboarding gap only. No old mock-test import, desktop production import or case-name outcome switch.
import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { AssertionError } from "node:assert";
import { runScenario, assertScenario } from "./p1-desktop-admission.contract.fixture";
import { createAdmissionModel } from "./p1-desktop-admission.model.fixture";
import { onboardingAtomicScenarios } from "./p1-desktop-onboarding-atomic.scenarios.fixture";
for (const item of onboardingAtomicScenarios) {
  test(item.name + " / correct input-only independent model", async () => {
    const observed = await runScenario(item, createAdmissionModel());
    assertScenario(item, observed);
    console.log(JSON.stringify({ scenario: item.name, mode: "OnboardingAtomicMock", observed }));
  });
  for (const defect of item.rejects) {
    test(item.name + " / SAME assertions reject " + defect, async () => {
      // Establish the healthy comparison path before attempting the interaction defect.
      assertScenario(item, await runScenario(item, createAdmissionModel()));
      const observed = await runScenario(item, createAdmissionModel(defect));
      let rejection: unknown;
      try { assertScenario(item, observed); } catch (error) { rejection = error; }
      // Provider execution is outside the catch. Only the SAME effects assertion validates this control.
      assert.ok(rejection instanceof AssertionError, "interaction control did not reach the frozen assertion");
      assert.equal(rejection.code, "ERR_ASSERTION");
      assert.equal(rejection.operator, "deepStrictEqual");
      assert.deepEqual(rejection.actual, observed.effects);
      assert.deepEqual(rejection.expected, item.expected.effects);
      console.log(JSON.stringify({ scenario: item.name, defect, rejected: true, rejection: String(rejection), observed }));
    });
  }
}
test("onboarding atomic inventory: eight new cases, thirty-seven interaction controls", () => {
  expect(onboardingAtomicScenarios).toHaveLength(8);
  expect(onboardingAtomicScenarios.reduce((sum, item) => sum + item.rejects.length, 0)).toBe(37);
});


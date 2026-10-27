// SPDX-License-Identifier: Apache-2.0
import { AssertionError, fail, strictEqual } from "node:assert/strict";
import { describe, it } from "vitest";
import {
  admissionControls, admissionScenarios, assertAdmissionScenario, runAdmissionModel,
} from "./schedule-admission-boundary.fixture";

describe("P1 schedule pair admission before persistence (independent model only)", () => {
  for (const scenario of admissionScenarios) {
    it(scenario.id, async () => {
      const observed = await runAdmissionModel(structuredClone(scenario.input));
      console.log(JSON.stringify({ case: scenario.id, observed }));
      assertAdmissionScenario(scenario, observed);
    });
  }
  for (const control of admissionControls) {
    it(`rejects ${control.fault} for ${control.scenario}`, async () => {
      const scenario = admissionScenarios.find(row => row.id === control.scenario);
      if (!scenario) throw new Error("unknown input");
      const observed = await runAdmissionModel(structuredClone(scenario.input), control.fault);
      let rejected = false;
      try { assertAdmissionScenario(scenario, observed); }
      catch (error) {
        if (!(error instanceof AssertionError)) throw error;
        strictEqual(error.code, "ERR_ASSERTION");
        rejected = true;
      }
      if (!rejected) fail("fault must be rejected by SAME assertions, not an incidental exception");
      console.log(JSON.stringify({ control, assertionRejected: rejected, observed }));
    });
  }
});

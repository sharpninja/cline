// SPDX-License-Identifier: Apache-2.0
import { AssertionError, fail, strictEqual } from "node:assert/strict";
import { describe, it } from "vitest";
import {
  assertBootstrapScenario, bootstrapControls, bootstrapScenarios, runBootstrapModel,
} from "./local-runtime-host.cloud-bootstrap-boundary.fixture";

describe("P1 existing manager seam cloud bootstrap boundary (model only)", () => {
  for (const scenario of bootstrapScenarios) {
    it(scenario.id, async () => {
      // Pass ONLY inputs. The model/dependencies cannot read expected records.
      const observed = await runBootstrapModel(structuredClone(scenario.input));
      console.log(JSON.stringify({ case: scenario.id, observed }));
      assertBootstrapScenario(scenario, observed);
    });
  }
  for (const control of bootstrapControls) {
    it(`rejects ${control.fault} for ${control.scenario}`, async () => {
      const scenario = bootstrapScenarios.find(row => row.id === control.scenario);
      if (!scenario) throw new Error("unknown control input");
      // Incidental model/dependency exceptions are never assertion rejections.
      const observed = await runBootstrapModel(structuredClone(scenario.input), control.fault);
      let rejected = false;
      try { assertBootstrapScenario(scenario, observed); }
      catch (error) {
        if (!(error instanceof AssertionError)) throw error;
        strictEqual(error.code, "ERR_ASSERTION");
        rejected = true;
      }
      if (!rejected) fail("intended faulty interaction was not rejected by SAME assertions");
      console.log(JSON.stringify({ control, assertionRejected: rejected, observed }));
    });
  }
});

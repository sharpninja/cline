import { AssertionError } from "node:assert";
import { describe, it } from "vitest";
import {
  applies, assertSelection, cases, createHarness, exerciseFault, faults, inputFor, model,
} from "./local-runtime-host.manager-boundary.fixture";

describe("existing host manager selection: independent input-only mock", () => {
  for (const fixture of cases) {
    it(fixture.name, () => {
      const harness = createHarness();
      const observed = model(inputFor(fixture.input, harness), harness.dependencies);
      assertSelection(fixture, harness, observed);
      console.info("MANAGER_BOUNDARY_CAPTURE " + JSON.stringify({
        name: fixture.name,
        provider: observed.providerSettingsManager.label,
        oauth: observed.oauthTokenManager.label,
        trace: harness.trace,
      }));
    });
    for (const fault of faults.filter((candidate) => applies(candidate, fixture))) {
      it(`${fixture.name} rejects ${fault} through SAME assertions`, () => {
        const harness = createHarness();
        // Model errors are not counted as assertion rejection.
        const observed = exerciseFault(inputFor(fixture.input, harness), harness, fault);
        let rejected = false;
        try {
          assertSelection(fixture, harness, observed);
      console.info("MANAGER_BOUNDARY_CAPTURE " + JSON.stringify({
        name: fixture.name,
        provider: observed.providerSettingsManager.label,
        oauth: observed.oauthTokenManager.label,
        trace: harness.trace,
      }));
        } catch (error) {
          if (!(error instanceof AssertionError)) throw error;
          rejected = true;
        }
        if (!rejected) throw new Error(`Assertion failed to reject ${fault}`);
      });
    }
  }
});

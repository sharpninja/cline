// SPDX-License-Identifier: Apache-2.0
/** P1 constructor isolation assertion prerequisite only. No native/live/phase acceptance. */
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { constructorScenarios } from "./__fixtures__/p1-constructor-isolation-cases";
import { assertConstructorIsolation, runConstructorScenario } from "./__fixtures__/p1-constructor-isolation-contract";
import { independentConstructorAdapter } from "./__fixtures__/p1-constructor-isolation-model";
const evidence: unknown[] = [];
describe("P1 constructor raw-read OAuth isolation independent contract", () => {
  for (const scenario of constructorScenarios) {
    it("correct input-only dependencies: " + scenario.id, async () => {
      const actual = await runConstructorScenario(independentConstructorAdapter, scenario);
      assertConstructorIsolation(actual, scenario.expected);
      assert.deepStrictEqual(actual.exercisedFaults, [], "CONSTRUCTOR_ISOLATION:unexpected fault");
      evidence.push({ id: scenario.id, requirements: scenario.requirements, nativeSteps: scenario.nativeSteps, actual });
    });
    for (const fault of scenario.controls) {
      it("SAME assertions reject " + scenario.id + "/" + fault, async () => {
        const actual = await runConstructorScenario(independentConstructorAdapter, scenario, fault);
        assert.deepStrictEqual(actual.exercisedFaults, [fault], "Control must actually execute the intended wrong dependency/effect: " + fault);
        let rejection: assert.AssertionError | undefined;
        try { assertConstructorIsolation(actual, scenario.expected); } catch (error) {
          if (!(error instanceof assert.AssertionError) || error.code !== "ERR_ASSERTION" || !error.message.startsWith("CONSTRUCTOR_ISOLATION:")) throw error;
          rejection = error;
        }
        assert.ok(rejection, "Control did not reach the SAME intended contract assertion: " + fault);
        evidence.push({ id: scenario.id, fault, intendedRejection: rejection.code, assertion: rejection.message.split("\n")[0], actual });
      });
    }
  }
  it("publishes full interaction proof and honest scope", () => {
    const correct = constructorScenarios.length;
    const rejecting = constructorScenarios.reduce((sum, scenario) => sum + scenario.controls.length, 0);
    assert.equal(correct, 16, "CONSTRUCTOR_ISOLATION:original scenario inventory");
    assert.equal(rejecting, 462, "CONSTRUCTOR_ISOLATION:rejecting inventory");
    assert.equal(new Set(constructorScenarios.map((scenario) => scenario.id)).size, correct, "CONSTRUCTOR_ISOLATION:unique scenario identities");
    assert.equal(evidence.length, correct + rejecting, "CONSTRUCTOR_ISOLATION:proof completeness");
    console.log("K17_CONSTRUCTOR_ISOLATION_EVIDENCE " + JSON.stringify({ correct, rejecting, registered: correct + rejecting + 1, importedRunnerRegistrations: 0, productionBound: false, nativeBound: false, entries: evidence }));
  });
});



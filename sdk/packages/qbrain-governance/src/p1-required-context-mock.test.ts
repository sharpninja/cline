// SPDX-License-Identifier: Apache-2.0
/** AC-QB-002/005/006 exact provider-context sub-obligations only, not host/phase acceptance. */
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { successfulScenarios, unavailableScenarios } from "./__fixtures__/p1-required-context-cases";
import { assertRequiredContext } from "./__fixtures__/p1-required-context-contract";
import { faults, independentContextAdapter, type Fault } from "./__fixtures__/p1-required-context-model";
const evidence: unknown[] = [];
describe("P1 exact required provider context independent mock contract", () => {
  for (const scenario of [...successfulScenarios, ...unavailableScenarios]) {
    it("correct input-only boundary: " + scenario.id, async () => {
      const before = structuredClone({ invocations: scenario.invocations, replies: scenario.replies });
      const actual = await independentContextAdapter.execute(scenario.invocations, scenario.replies);
      assertRequiredContext(actual, scenario.expected);
      assert.deepStrictEqual({ invocations: scenario.invocations, replies: scenario.replies }, before, "REQUIRED_CONTEXT:caller-owned input mutation");
      evidence.push({ id: scenario.id, requirementIds: scenario.requirementIds, nativeStepIds: scenario.nativeStepIds, actual });
    });
    const controls: readonly Fault[] = successfulScenarios.includes(scenario) ? faults :
      ["dispatch-before-context", "omit-context-read", "duplicate-context-read"];
    for (const fault of controls) {
      it("SAME assertions reject " + scenario.id + "/" + fault, async () => {
        // Exercise bad dependency replies, callback order and dispatch effects.
        // Incidental implementation errors are failures, never intended negative-control success.
        const actual = await independentContextAdapter.execute(scenario.invocations, scenario.replies, fault);
        let rejection: assert.AssertionError | undefined;
        try { assertRequiredContext(actual, scenario.expected); } catch (error) {
          if (!(error instanceof assert.AssertionError) || error.code !== "ERR_ASSERTION" || !error.message.startsWith("REQUIRED_CONTEXT:")) throw error;
          rejection = error;
        }
        assert.ok(rejection, "Control did not reach the SAME intended contract assertion: " + fault);
        evidence.push({ id: scenario.id, fault, intendedRejection: rejection.code, assertion: rejection.message.split("\n")[0], actual });
      });
    }
  }
  it("publishes exact bounded proof and honest denominators", () => {
    const correct = successfulScenarios.length + unavailableScenarios.length;
    const rejecting = successfulScenarios.length * faults.length + unavailableScenarios.length * 3;
    assert.equal(evidence.length, correct + rejecting, "REQUIRED_CONTEXT:proof completeness");
    console.log("K14_REQUIRED_CONTEXT_EVIDENCE " + JSON.stringify({ correct, rejecting, importedRunnerRegistrations: 0, productionBound: false, entries: evidence }));
  });
});

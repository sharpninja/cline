// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { afterAll, describe, it } from "vitest";
import { assertNativeMember, faults, intendedRejection, runNativeMember, snapshot, type Fault, type Observation, type Scenario } from "./__fixtures__/p1-native-member-contract";
import { nativeMemberScenarios } from "./__fixtures__/p1-native-member-cases";
import { nativeMemberModel } from "./__fixtures__/p1-native-member-model";
const discriminators: Record<Fault, string> = {
  "omit-native": "descriptor", "non-callable-native": "descriptor",
  "wrong-enumerable": "descriptor", "wrong-configurable": "descriptor", "wrong-writable": "descriptor",
  "wrong-receiver": "receiver", "drop-argument": "argument-count", "wrong-path": "literal-path-order",
  "wrong-options": "options-identity", "clone-options": "options-identity", "wrong-result": "literal-result-identity",
  "wrong-error": "error-identity", "omit-call": "call-count", "duplicate-call": "call-count", "reorder-calls": "literal-path-order",
  "omit-emission": "emission-order-count", "duplicate-emission": "emission-order-count", "reorder-emission": "emission-order-count", "mutate-input": "input-immutability", "late-call-emission": "cross-stream-order",
};
const evidence: unknown[] = [];
let correct = 0, rejected = 0;
function record(scenario: Scenario, actual: Observation, fault: Fault | null, rejection: string | null, rejectionError: unknown = null) {
  evidence.push({ id: scenario.id, fault, rejection, rejectionError: snapshot(rejectionError), input: snapshot(scenario.input), actual: snapshot(actual),
    resultReferenceMatches: actual.outcomes.map((value, index) => value.value === scenario.input.replies[index]?.value),
    optionsReferenceMatches: actual.calls.map((value, index) => value.args[1] === scenario.input.invocations[index]?.args[1]) });
}
describe("P1 native member independent input-only mock prerequisite", () => {
  for (const [index, identity] of nativeMemberScenarios().entries()) {
    describe(identity.id, () => {
      it("forwards original callable/descriptor/receiver/arguments/results/errors and exact effects", () => {
        const scenario = nativeMemberScenarios()[index]!;
        const actual = runNativeMember(nativeMemberModel, scenario.input);
        record(scenario, actual, null, null);
        assertNativeMember(actual, scenario);
        assert.deepStrictEqual(actual.exercised, []);
        correct++;
      });
      for (const fault of faults) it("SAME assertions reject exercised " + fault, () => {
        const scenario = nativeMemberScenarios()[index]!;
        const actual = runNativeMember(nativeMemberModel, scenario.input, fault);
        let rejection: unknown;
        try { assertNativeMember(actual, scenario); } catch (error) { rejection = error; }
        record(scenario, actual, fault, rejection instanceof Error ? rejection.message : String(rejection), rejection);
        assert.ok(actual.exercised.includes(fault), "CONTROL_NOT_EXERCISED:" + fault);
        assert.ok(intendedRejection(rejection), "CONTROL_REQUIRES_INTENDED_ASSERTION:" + fault);
        if (fault === "reorder-calls") {
          const inputOrder = [1, 0] as const;
          assert.equal(actual.calls.length, inputOrder.length, "CONTROL_REORDER_TRACE:call-count");
          for (const [position, originalIndex] of inputOrder.entries()) {
            const call = actual.calls[position]!, invocation = scenario.input.invocations[originalIndex]!;
            assert.strictEqual(call.receiver, scenario.expectedReceivers[originalIndex], "CONTROL_REORDER_TRACE:receiver");
            assert.equal(call.args.length, invocation.args.length, "CONTROL_REORDER_TRACE:argument-count");
            assert.strictEqual(call.args[0], invocation.args[0], "CONTROL_REORDER_TRACE:literal-path");
            assert.strictEqual(call.args[1], invocation.args[1], "CONTROL_REORDER_TRACE:options-identity");
          }
        }
        const discriminator = fault === "reorder-calls" && scenario.expectedReceivers[0] !== scenario.expectedReceivers[1] ? "receiver" : discriminators[fault];
        assert.ok(String((rejection as Error).message).startsWith("NATIVE_MEMBER:" + discriminator), "CONTROL_WRONG_ASSERTION:" + fault);
        rejected++;
      });
    });
  }
  it("does not count an unrelated executed model crash as assertion rejection", () => {
    const scenario = nativeMemberScenarios()[0]!;
    let observed: unknown;
    try { runNativeMember(nativeMemberModel, scenario.input, "unrelated-crash"); } catch (error) { observed = error; }
    assert.equal((observed as Error)?.message, "UNRELATED_MODEL_CRASH");
    assert.equal(intendedRejection(observed), false);
  });
  for (const [name, error] of [["incidental TypeError", new TypeError("missing native")], ["ordinary Error", new Error("NATIVE_MEMBER:descriptor")], ["unqualified assertion", new assert.AssertionError({ message: "another assertion", actual: 1, expected: 2, operator: "strictEqual" })]] as const) {
    it("does not count " + name + " as an intended rejection", () => { assert.equal(intendedRejection(error), false); });
  }
  afterAll(() => {
    const scenarios = nativeMemberScenarios().length;
    try {
      assert.equal(correct, scenarios, "PROOF: every original correct vector executed");
      assert.equal(rejected, scenarios * faults.length, "PROOF: every planned scenario/control executed");
      assert.equal(evidence.length, correct + rejected, "PROOF: complete interaction evidence");
    } finally {
      console.log("NATIVE_MEMBER_MODEL_EVIDENCE " + JSON.stringify({ scenarios, correct, rejected, classifierCases: 4, registrations: correct + rejected + 4, productionBound: false, actualCaptureHelperBound: false, nativeConstructorAccepted: false, evidence }));
    }
  });
});

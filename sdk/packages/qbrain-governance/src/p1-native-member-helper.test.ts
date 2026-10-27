// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { afterAll, it } from "vitest";
import { captureNativeMember } from "./__fixtures__/capture-native-member.mjs";
import { nativeMemberScenarios } from "./__fixtures__/p1-native-member-cases";
import { assertNativeMember, runNativeMember, snapshot, type Adapter, type Member } from "./__fixtures__/p1-native-member-contract";
const actual: Adapter = { bind(original, emit) {
  const wrapped: Member = function (this: unknown, ...args: unknown[]) { return Reflect.apply(original, this, args); };
  return captureNativeMember(original, wrapped, emit);
} };
const evidence: unknown[] = [];
for (const scenario of nativeMemberScenarios()) {
  it("actual native forwarding helper: " + scenario.id, () => {
    const observed = runNativeMember(actual, scenario.input);
    assertNativeMember(observed, scenario);
    evidence.push({ id: scenario.id, input: snapshot(scenario.input), actual: snapshot(observed),
      resultReferenceMatches: observed.outcomes.map((value, index) => value.value === scenario.input.replies[index]!.value),
      optionsReferenceMatches: observed.calls.map((value, index) => value.args[1] === scenario.input.invocations[index]!.args[1]) });
  });
}
afterAll(() => {
  try { assert.equal(evidence.length, 12, "ACTUAL_HELPER: complete original input set"); }
  finally { console.log("NATIVE_MEMBER_ACTUAL_HELPER_EVIDENCE " + JSON.stringify({ correct: evidence.length, evidence, nativeConstructorAccepted: false, fullSDKAccepted: false })); }
});

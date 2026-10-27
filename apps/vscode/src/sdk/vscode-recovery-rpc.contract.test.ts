// SPDX-License-Identifier: Apache-2.0
// Independent mock prerequisite preparation only. SAME assertRecoveryRpc is for later actual binding.
import assert from "node:assert/strict";
import { assertRecoveryRpc, cases, controlsFor, qualify } from "./vscode-recovery-rpc.contract.test-support";
import { model } from "./vscode-recovery-rpc.model.test-support";
export async function proveRecoveryRpc() {
const evidence: unknown[] = [], failures: unknown[] = [];
let correct = 0, rejected = 0, guards = 0;
for (const scenario of cases) {
  try { evidence.push(await assertRecoveryRpc(scenario, model())); correct++; }
  catch (error) { failures.push({ name: scenario.name, correctMock: true, message: String(error) }); }
  for (const fault of controlsFor(scenario)) {
    try {
      await assertRecoveryRpc(scenario, model(fault));
      failures.push({ name: scenario.name, fault, message: "incorrect interaction was accepted" });
    } catch (error) {
      if (!qualify(error, fault)) { failures.push({ name: scenario.name, fault, message: "wrong first rejection", actual: String(error) }); continue; }
      const original = error as assert.AssertionError & { interactionEvidence: Record<string, unknown> };
      evidence.push({ name: scenario.name, fault, assertion: original.message, operator: original.operator, interactionEvidence: original.interactionEvidence });
      rejected++;
      const mutate = (message: string, operator: string, interactionEvidence: unknown) => {
        const candidate = new assert.AssertionError({ message, operator, actual: 1, expected: 2 });
        Object.assign(candidate, { interactionEvidence });
        return candidate;
      };
      for (const invalid of [
        new Error("unrelated nonassertion"),
        mutate("unrelated assertion", original.operator, original.interactionEvidence),
        mutate(original.message, "unrelatedOperator", original.interactionEvidence),
        mutate(original.message, original.operator, undefined),
        mutate(original.message, original.operator, { calls: [], inputs: [], journal: [], renderBefore: null }),
      ]) {
        assert.equal(qualify(invalid, fault), false, "recovery-rpc-rejects-unqualified-control");
        guards++;
      }
    }
  }
}
const plannedControls = cases.reduce((n, c) => n + controlsFor(c).length, 0);
const result = { mode: "independent-input-only-recovery-rpc-model", plannedCorrect: cases.length, correct,
  plannedControls, rejectedControls: rejected, plannedClassifierGuards: plannedControls * 5, classifierGuards: guards, failed: failures.length, skipped: 0,
  failures, evidence, durableAudit: false, nativeHost: false, scopeAccepted: false };
return result;
}
if (process.argv.includes("--mock-proof")) {
  const result = await proveRecoveryRpc(); console.log(JSON.stringify(result));
  if (result.failed || result.correct !== result.plannedCorrect || result.rejectedControls !== result.plannedControls || result.classifierGuards !== result.plannedClassifierGuards) process.exitCode = 1;
} else {
  const { it } = await import("vitest");
  for (const scenario of cases) it(`preserves raw recovery-rpc callback: ${scenario.name}`, () => assertRecoveryRpc(scenario, model()));
  it("qualifies actual recovery-rpc rejecting interactions and classifier guards", async () => {
    const result = await proveRecoveryRpc();
    assert.deepStrictEqual(result.failures, []);
    assert.equal(result.correct, result.plannedCorrect);
    assert.equal(result.rejectedControls, result.plannedControls);
    assert.equal(result.classifierGuards, result.plannedClassifierGuards);
  });
}

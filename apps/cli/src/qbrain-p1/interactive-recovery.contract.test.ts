// SPDX-License-Identifier: Apache-2.0
// Independent model prerequisite only. --mock-proof is explicit, no production/provider imports.
import assert from "node:assert/strict";
import { assertInteractiveRecovery, scenarios, qualify } from "./interactive-recovery.contract.test-support";
import { model } from "./interactive-recovery.model.test-support";
export async function proveInteractiveRecovery() {
 const evidence: unknown[] = [], failures: unknown[] = [];
 let correct = 0, rejected = 0, guards = 0;
 for (const scenario of scenarios) {
  try { evidence.push(await assertInteractiveRecovery(scenario, model())); correct++; }
  catch (error) { failures.push({ name: scenario.name, correctMock: true, message: String(error) }); }
  for (const fault of scenario.controls) {
   try {
    const accepted = await assertInteractiveRecovery(scenario, model(fault));
    failures.push({ name: scenario.name, fault, message: "incorrect interaction accepted", evidence: accepted });
   } catch (error) {
    if (!qualify(error, scenario, fault)) {
     failures.push({ name: scenario.name, fault, message: "wrong first rejection", actual: String(error),
      diagnostic: error instanceof assert.AssertionError ? { name: error.name, code: error.code, operator: error.operator, message: error.message } : undefined,
      evidence: (error as { interactionEvidence?: unknown })?.interactionEvidence });
     continue;
    }
    const original = error as assert.AssertionError & { interactionEvidence: Record<string, unknown> };
    evidence.push({ name: scenario.name, fault, assertion: original.message, operator: original.operator,
     errorName: original.name, errorCode: original.code,
     interactionEvidence: original.interactionEvidence }); rejected++;
    const mutate = (message: string, operator: string, interactionEvidence: unknown) =>
     Object.assign(new assert.AssertionError({ message, operator, actual: 1, expected: 2 }), { interactionEvidence });
    for (const invalid of [
     new Error("unrelated exception"),
     mutate("unrelated assertion", original.operator, original.interactionEvidence),
     mutate(original.message, "unrelatedOperator", original.interactionEvidence),
     mutate(original.message, original.operator, undefined),
     mutate(original.message, original.operator, { name: "other-scenario", inputs: [], journal: [], sends: [] }),
    ]) {
     assert.equal(qualify(invalid, scenario, fault), false, "interactive-rejects-unqualified-control");
     guards++;
    }
   }
  }
 }
 const plannedControls = scenarios.reduce((sum, scenario) => sum + scenario.controls.length, 0);
 return { mode: "independent-input-only-interactive-recovery-model", plannedCorrect: scenarios.length, correct,
  plannedControls, rejectedControls: rejected, plannedClassifierGuards: plannedControls * 5, classifierGuards: guards,
  failed: failures.length, skipped: 0, failures, evidence,
  nativeHost: false, SDKRuntimeConsumed: false, providerExecuted: false, durableAudit: false, scopeAccepted: false };
}
if (process.argv.includes("--mock-proof")) {
 const result = await proveInteractiveRecovery();
 console.log(JSON.stringify(result));
 if (result.failed || result.correct !== 9 || result.plannedControls !== 54 ||
  result.rejectedControls !== 54 || result.classifierGuards !== 270) process.exitCode = 1;
} else {
 const { it } = await import("vitest");
 for (const scenario of scenarios) {
  it("preserves interactive factory contract: " + scenario.name, () => assertInteractiveRecovery(scenario, model()));
 }
 it("qualifies the same interactive recovery rejecting interactions and classifier guards", async () => {
  const result = await proveInteractiveRecovery();
  assert.deepStrictEqual(result.failures, []);
  assert.equal(result.correct, 9);
  assert.equal(result.plannedControls, 54);
  assert.equal(result.rejectedControls, 54);
  assert.equal(result.classifierGuards, 270);
 });
}


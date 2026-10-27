// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { assertSendBoundary, boundaryCases, controlsFor } from "./vscode-send-boundary.contract.test-support";
import { modelFactory } from "./vscode-send-boundary.model.test-support";
import { assertQualificationGuards, qualifyBoundaryRejection } from "./vscode-send-boundary.qualification.test-support";
function observedValue(value: unknown) {
  return value instanceof Error ? { name: value.name, message: value.message, stack: value.stack,
    operator: value instanceof assert.AssertionError ? value.operator : undefined } : value;
}
export async function proveSendBoundary() {
  const evidence: unknown[] = [], failures: { name: string; error: string }[] = [];
  let correct = 0, plannedControls = 0, rejectedControls = 0, qualificationGuards = 0;
  for (const scenario of boundaryCases) {
    let correctEvidence: unknown;
    try { correctEvidence = await assertSendBoundary(scenario, modelFactory()); evidence.push(correctEvidence); correct++; }
    catch (error) { failures.push({ name: scenario.name, error: String(error) }); }
    for (const fault of controlsFor(scenario)) {
      plannedControls++;
      try { await assertSendBoundary(scenario, modelFactory(fault)); failures.push({ name: `${scenario.name}/${fault}`, error: "incorrect interaction accepted" }); }
      catch (error) {
        const interactions = error instanceof assert.AssertionError
          ? (error as assert.AssertionError & { interactionEvidence: unknown }).interactionEvidence : undefined;
        const qualification = qualifyBoundaryRejection(scenario, fault, error, interactions);
        // Never count a generic AssertionError, unrelated first failure, or unexercised fault.
        if (qualification.accepted && error instanceof assert.AssertionError) {
          try {
            qualificationGuards += assertQualificationGuards(scenario, fault, error, interactions, correctEvidence);
            rejectedControls++;
            evidence.push({ name: scenario.name, fault, qualification, rejection: error.message, operator: error.operator,
              actual: observedValue(error.actual), expected: observedValue(error.expected), interactionEvidence: interactions });
          } catch (guardError) {
            failures.push({ name: `${scenario.name}/${fault}/classifier-guards`, error: String(guardError) });
          }
        } else {
          evidence.push({ name: scenario.name, fault, qualification, error: String(error), interactionEvidence: interactions });
          failures.push({ name: `${scenario.name}/${fault}`, error: `unqualified rejection: ${qualification.reason}; ${String(error)}` });
        }
      }
    }
  }
  return { mode: "Mock", plannedCorrect: boundaryCases.length, correct, plannedControls, rejectedControls,
    plannedQualificationGuards: plannedControls * 4, qualificationGuards,
    failed: failures.length, skipped: 0, failures, evidence, actualHost: false, productionBound: false };
}
if (process.argv.includes("--mock-proof")) {
  const result = await proveSendBoundary();
  console.log(JSON.stringify(result));
  if (result.failed) process.exitCode = 1;
} else {
  const { it } = await import("vitest");
  for (const scenario of boundaryCases) it(`preserves public send boundary: ${scenario.name}`, () => assertSendBoundary(scenario, modelFactory()));
  it("qualifies intended rejecting interactions and rejects unrelated/unexercised controls", async () => {
    const result = await proveSendBoundary();
    assert.deepStrictEqual(result.failures, []);
    assert.equal(result.rejectedControls, result.plannedControls);
    assert.equal(result.qualificationGuards, result.plannedQualificationGuards);
  });
}


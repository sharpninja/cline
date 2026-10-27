// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import type { CompletionCase } from "./p1-completion-evidence-cases";
import type { CompletionEvidenceAdapter, Observation } from "./p1-completion-evidence-model";

export const assertionPrefix = "EXACT_COMPLETION:";
/** SAME assertion contract for independent mock and later accepted production
 * adapters. Only captured input reaches execute. Expected complete records stay
 * exclusively in this runner, never in the dependency response script.
 */
export async function assertCompletionEvidence(
 fixture: CompletionCase, adapter: CompletionEvidenceAdapter,
): Promise<Observation> {
 const input = structuredClone(fixture.input);
 const before = structuredClone(input);
 const actual = await adapter.execute(input);
 assert.deepStrictEqual(input, before, assertionPrefix + " immutable captured input");
 for (const name of ["turns", "events", "receipts", "projections", "journal", "rejected", "trace", "effects", "outcome", "delivered"] as const) {
  assert.deepStrictEqual(actual[name], fixture.expected[name], assertionPrefix + " " + name);
 }
 // Typed receipt validation is deliberately explicit in addition to exact sets.
 // A string/boolean/fraction/NaN/infinity never proves a committed revision.
 for (const item of actual.receipts) {
  assert.ok(item.receipt && typeof item.receipt === "object", assertionPrefix + " receipt object");
  const receipt = item.receipt as Record<string, unknown>;
  if (receipt.code === "persisted" || receipt.code === "unchanged") {
   assert.equal(typeof receipt.revision, "number", assertionPrefix + " numeric revision");
   assert.ok(Number.isFinite(receipt.revision) && Number.isInteger(receipt.revision) &&
    (receipt.revision as number) > 0, assertionPrefix + " positive committed revision");
   assert.equal(item.verified, true, assertionPrefix + " independent revision read");
  } else {
   assert.equal(receipt.code, "rejected", assertionPrefix + " explicit terminal rejection");
   assert.equal(actual.outcome, "blocked", assertionPrefix + " terminal retained even with empty journal");
  }
 }
 assert.equal(actual.delivered, false, assertionPrefix + " commit does not prove operator delivery");
 if (fixture.canceled) {
  for (const turn of actual.turns) {
   assert.equal(Object.hasOwn(turn as object, "response"), false, assertionPrefix + " canceled has no invented final");
  }
 }
 return actual;
}

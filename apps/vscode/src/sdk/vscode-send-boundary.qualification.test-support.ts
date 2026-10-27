// SPDX-License-Identifier: Apache-2.0
// O finding C16-MOCK-QUALIFICATION-001. Classification is independent of the model.
// A fault label alone, an unrelated assertion or an unexercised trace never qualifies.
import assert from "node:assert/strict";
import type { Fault, SendInput, SendResult } from "./vscode-send-boundary.contract.test-support";
import type { boundaryCases } from "./vscode-send-boundary.contract.test-support";
type Scenario = (typeof boundaryCases)[number];
type Event = { boundary: string; ordinal: number; text?: string; input?: SendInput };
type Evidence = { journal: Event[]; admissions: { captureId: string; input: SendInput }[]; calls: SendInput[]; delivered: { ordinal: number; value: SendResult }[] };
export function intendedFirstRejection(scenario: Scenario, fault: Fault) {
  if (fault === "trim-input" || fault === "foreign-session")
    return { message: "captured complete request/session/delivery is unchanged", operator: "deepStrictEqual" };
  if (fault === "early-return" || (scenario.held && fault === "missing-call"))
    return { message: "public return is withheld while actual dependency is pending", operator: "strictEqual" };
  if (scenario.reject)
    return { message: "preserve original error identity", operator: "strictEqual" };
  if (fault === "duplicate-call")
    return { message: "valid response must not become an error", operator: "strictEqual" };
  return { message: "return exact final dependency object after all dependency hooks", operator: "strictEqual" };
}
function asEvidence(value: unknown): Evidence | undefined {
  if (!value || typeof value !== "object") return;
  const candidate = value as Partial<Evidence>;
  if (!Array.isArray(candidate.journal) || !Array.isArray(candidate.admissions) ||
      !Array.isArray(candidate.calls) || !Array.isArray(candidate.delivered)) return;
  return candidate as Evidence;
}
export function qualifyBoundaryRejection(scenario: Scenario, fault: Fault, error: unknown, rawEvidence: unknown) {
  const intended = intendedFirstRejection(scenario, fault);
  const deny = (reason: string) => ({ accepted: false, reason, intended, observedDefect: false });
  if (!(error instanceof assert.AssertionError)) return deny("not-an-assertion-error");
  if (error.message.split(/\r?\n/, 1)[0] !== intended.message || error.operator !== intended.operator)
    return deny("unrelated-first-assertion-or-operator");
  const evidence = asEvidence(rawEvidence);
  if (!evidence) return deny("missing-captured-interactions");
  const { journal, admissions, calls, delivered } = evidence;
  if (!admissions.length || !journal.some(event => event.boundary === "caller-admission"))
    return deny("no-actual-admission");
  const eventIndex = (boundary: string) => journal.findIndex(event => event.boundary === boundary);
  const returned = journal.find(event => event.boundary === "inner-return");
  const earlier = journal.find(event => event.boundary === "earlier-hook");
  const callerText = delivered[0]?.value?.text;
  let exercised = false;
  switch (fault) {
    case "trim-input":
      exercised = calls.some((call, index) => {
        const original = admissions[index]?.input;
        return original && call.sessionId === original.sessionId && call.delivery === original.delivery &&
          call.prompt !== original.prompt && call.prompt === original.prompt.trim();
      });
      break;
    case "foreign-session":
      exercised = calls.some((call, index) => {
        const original = admissions[index]?.input;
        return original && call.sessionId !== original.sessionId && call.prompt === original.prompt && call.delivery === original.delivery;
      });
      break;
    case "duplicate-call":
      exercised = calls.length > admissions.length && journal.filter(event => event.boundary === "inner-enter").length === calls.length;
      break;
    case "missing-call":
      exercised = calls.length === 0 && eventIndex("inner-enter") === -1 && eventIndex("caller-return") > eventIndex("caller-admission");
      break;
    case "drop-empty":
      exercised = admissions[0].input.prompt === "" && calls.length === 0 && eventIndex("caller-return") > eventIndex("caller-admission");
      break;
    case "coalesce-equal":
      exercised = admissions.length === 2 && admissions[0].captureId !== admissions[1].captureId &&
        admissions[0].input.prompt === admissions[1].input.prompt && calls.length === 1 &&
        delivered.length === 2 && delivered[0].value.text === delivered[1].value.text;
      break;
    case "stale-result":
      exercised = !!earlier && !!returned && callerText === earlier.text && callerText !== returned.text &&
        eventIndex("caller-return") > eventIndex("inner-return");
      break;
    case "summary-result":
      exercised = typeof callerText === "string" && typeof returned?.text === "string" &&
        callerText.length < returned.text.length && returned.text.includes(callerText) &&
        eventIndex("caller-return") > eventIndex("inner-return");
      break;
    case "swallow-error":
      exercised = scenario.reject === true && eventIndex("inner-error") >= 0 &&
        eventIndex("caller-return") > eventIndex("inner-error") && eventIndex("caller-error") === -1;
      break;
    case "early-return":
      exercised = scenario.held === true && eventIndex("inner-enter") >= 0 &&
        eventIndex("caller-return") > eventIndex("inner-enter") &&
        (eventIndex("inner-return") === -1 || eventIndex("caller-return") < eventIndex("inner-return"));
      break;
  }
  if (!exercised) return deny("declared-observable-defect-not-exercised");
  return { accepted: true, reason: "captured-defect-and-exact-first-assertion", intended, observedDefect: true };
}
export function assertQualificationGuards(scenario: Scenario, fault: Fault, error: assert.AssertionError, evidence: unknown, correctEvidence: unknown) {
  assert.ok(asEvidence(correctEvidence), "classifier guard requires an actual correctly exercised trace");
  const intended = intendedFirstRejection(scenario, fault);
  const unrelated = new assert.AssertionError({ message: "unrelated assertion", operator: intended.operator });
  const wrongOperator = new assert.AssertionError({ message: intended.message, operator: "unrelatedOperator" });
  const nonassert = new Error(intended.message);
  // Same observed faulty trace cannot qualify an unrelated error class/assertion/operator.
  assert.equal(qualifyBoundaryRejection(scenario, fault, unrelated, evidence).accepted, false, "reject unrelated assertion");
  assert.equal(qualifyBoundaryRejection(scenario, fault, wrongOperator, evidence).accepted, false, "reject unrelated operator");
  assert.equal(qualifyBoundaryRejection(scenario, fault, nonassert, evidence).accepted, false, "reject nonassert error");
  // Matching assertion metadata cannot qualify the correctly exercised, unmodified interactions.
  assert.equal(qualifyBoundaryRejection(scenario, fault, error, correctEvidence).accepted, false, "reject unexercised declared defect");
  return 4;
}

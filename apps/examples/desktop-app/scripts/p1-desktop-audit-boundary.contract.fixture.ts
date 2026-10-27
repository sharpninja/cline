// SPDX-License-Identifier: Apache-2.0
// Test-only observation contract, not a product SDK/API, transport or lifecycle service.
import assert from "node:assert/strict";
export type Identity = { captureId: string; workspaceId: string; nativeSessionId?: string; mcpSessionId: string; requestId: string };
export type Event =
  | { kind: "admission"; identity: Identity; input?: string | unknown[] }
  | { kind: "afterRun"; captureId: string; text: string }
  | { kind: "finalDelivery"; captureId: string; text: string };
export type Operation = { context: { workspaceId: string; nativeSessionId: string; mcpSessionId: string }; events: Event[] };
export type RecordValue = { phase: "ingress" | "final"; identity: Identity; value: unknown };
export type Effect = { kind: "write" | "deliveryAttempt" | "deliveryConfirmed" | "blocked"; value: unknown };
export type Dependencies = {
  write(value: RecordValue): Promise<void>;
  deliver(captureId: string, text: string): Promise<boolean>;
  confirm(captureId: string): void;
  block(reason: string): void;
};
export type Provider = (operation: Operation, dependencies: Dependencies) => Promise<void>;
export type Observation = { effects: Effect[]; stored: RecordValue[]; delivered: { captureId: string; text: string }[] };
export type Case = { name: string; input: Operation; deliveryOk?: Record<string, boolean>; expected: Observation; rejects: string[] };
const context = { workspaceId: "synthetic-workspace", nativeSessionId: "synthetic-native", mcpSessionId: "synthetic-mcp" };
export const identity = (captureId: string): Identity => ({ captureId, ...context, requestId: "request-" + captureId });
const write = (phase: RecordValue["phase"], id: string, value: unknown): Effect => ({ kind: "write", value: { phase, identity: identity(id), value } });
const attempt = (id: string, text: string): Effect => ({ kind: "deliveryAttempt", value: { captureId: id, text } });
const confirm = (id: string): Effect => ({ kind: "deliveryConfirmed", value: id });
const blocked = (reason: string): Effect => ({ kind: "blocked", value: reason });
function expected(effects: Effect[], delivered: Observation["delivered"]): Observation {
  return { effects, stored: effects.filter((item) => item.kind === "write").map((item) => item.value as RecordValue), delivered };
}
const admission = (id: string, input?: string | unknown[]): Event => ({ kind: "admission", identity: identity(id), input });
const final = (id: string, text: string): Event => ({ kind: "finalDelivery", captureId: id, text });
const op = (events: Event[]): Operation => ({ context, events });
// Expectations below are authored from AC069 and existing invocation-presence/final-delivery semantics.
// They never call the model, real desktop, normalization helper or provider output.
export const auditBoundaryCases: Case[] = [
  { name: "AC069 desktop: equal text has two independently attributed admissions", input: op([admission("a", "same"), admission("b", "same"), final("a", "queued"), final("b", "queued")]),
    expected: expected([write("ingress", "a", "same"), write("ingress", "b", "same"), write("final", "a", "queued"), attempt("a", "queued"), confirm("a"), write("final", "b", "queued"), attempt("b", "queued"), confirm("b")], [{ captureId: "a", text: "queued" }, { captureId: "b", text: "queued" }]),
    rejects: ["merge-equal", "wrong-identity", "omit-ingress"] },
  { name: "AC069 desktop: steering original whitespace Unicode and CRLF survive", input: op([admission("a", " \t雪\r\nsteer\r\n "), final("a", " \r\n雪 final\n ")]),
    expected: expected([write("ingress", "a", " \t雪\r\nsteer\r\n "), write("final", "a", " \r\n雪 final\n "), attempt("a", " \r\n雪 final\n "), confirm("a")], [{ captureId: "a", text: " \r\n雪 final\n " }]),
    rejects: ["trim-ingress", "drop-cr", "wrong-identity", "omit-ingress"] },
  { name: "AC069 desktop: explicit empty string is not inputless continuation", input: op([admission("a", ""), admission("internal", undefined), final("a", "explicit input rejected")]),
    expected: expected([write("ingress", "a", ""), write("final", "a", "explicit input rejected"), attempt("a", "explicit input rejected"), confirm("a")], [{ captureId: "a", text: "explicit input rejected" }]),
    rejects: ["omit-empty", "invent-inputless", "wrong-identity"] },
  { name: "AC069 desktop: explicit empty SDK input array is not continuation", input: op([admission("a", []), admission("internal", undefined), final("a", "empty invocation result")]),
    expected: expected([write("ingress", "a", []), write("final", "a", "empty invocation result"), attempt("a", "empty invocation result"), confirm("a")], [{ captureId: "a", text: "empty invocation result" }]),
    rejects: ["omit-empty", "invent-inputless", "wrong-identity"] },
  { name: "AC069 desktop: final host delivery supersedes earlier mutable hook result", input: op([admission("a", "request"), { kind: "afterRun", captureId: "a", text: "earlier hook" }, final("a", "later hook\r\nfinal")]),
    expected: expected([write("ingress", "a", "request"), write("final", "a", "later hook\r\nfinal"), attempt("a", "later hook\r\nfinal"), confirm("a")], [{ captureId: "a", text: "later hook\r\nfinal" }]),
    rejects: ["capture-early", "omit-final", "deliver-before-audit", "wrong-identity"] },
  { name: "AC069 desktop: prepared final result does not claim failed delivery received", input: op([admission("a", "request"), final("a", "prepared\r\nresult")]), deliveryOk: { a: false },
    expected: expected([write("ingress", "a", "request"), write("final", "a", "prepared\r\nresult"), attempt("a", "prepared\r\nresult"), blocked("delivery_failed")], []),
    rejects: ["ignore-delivery-failure", "omit-final", "deliver-before-audit"] },
  { name: "AC069 desktop: missing actual captured native identity never uses fallback", input: op([{ kind: "admission", identity: { ...identity("a"), nativeSessionId: undefined }, input: "request" }, final("a", "unattributed")]),
    expected: expected([blocked("missing_identity"), blocked("missing_admission")], []),
    rejects: ["invent-identity", "accept-invalid-identity"] },
  { name: "AC069 desktop: orphan final output cannot reconstruct admission", input: op([final("a", "unattributed")]),
    expected: expected([blocked("missing_admission")], []), rejects: ["allow-orphan"] },
];
export async function runAuditBoundaryCase(item: Case, provider: Provider): Promise<Observation> {
  const observation: Observation = { effects: [], stored: [], delivered: [] };
  // Independent test dependency owns actual storage/delivery records. Provider receives no case name/expected.
  const dependencies: Dependencies = {
    async write(value) { observation.stored.push(structuredClone(value)); observation.effects.push({ kind: "write", value: structuredClone(value) }); },
    async deliver(captureId, text) {
      observation.effects.push({ kind: "deliveryAttempt", value: { captureId, text } });
      if (item.deliveryOk?.[captureId] === false) return false;
      observation.delivered.push({ captureId, text }); return true;
    },
    confirm(captureId) { observation.effects.push({ kind: "deliveryConfirmed", value: captureId }); },
    block(reason) { observation.effects.push({ kind: "blocked", value: reason }); },
  };
  await provider(structuredClone(item.input), dependencies);
  return observation;
}
export function assertAuditBoundaryCase(item: Case, observed: Observation) {
  assert.deepStrictEqual(observed, item.expected, "complete independently recorded admission/storage/delivery interactions");
}

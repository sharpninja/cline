// SPDX-License-Identifier: Apache-2.0
// P1 bounded baseline seam: FR-QB-002/003/005, TEST-QB-005/007/013/069.
// This observes caller admission, dependency calls and public return only.
// It is not governed persistence, actual UI delivery, native host or provider evidence.
import assert from "node:assert/strict";

export type SendInput = { sessionId: string; prompt: string; delivery?: "queue" | "steer" };
export type SendResult = { text: string; usage?: { inputTokens: number }; marker?: string };
export type Sender = { send(input: SendInput): Promise<SendResult> };
export type Factory = (inner: Sender) => Sender;
export type Fault = "none" | "trim-input" | "foreign-session" | "duplicate-call" | "missing-call" |
  "coalesce-equal" | "drop-empty" | "stale-result" | "summary-result" | "swallow-error" | "early-return";
type Case = { name: string; inputs: SendInput[]; held?: boolean; reject?: boolean };
const raw = "  ## request\r\n\t雪 😀 **exact**\n\n";
export const boundaryCases: readonly Case[] = [
  { name: "raw-queue", inputs: [{ sessionId: "synthetic-A", prompt: raw, delivery: "queue" }] },
  { name: "raw-steering", inputs: [{ sessionId: "synthetic-A", prompt: raw, delivery: "steer" }] },
  { name: "equal-text-distinct-ingresses", inputs: [
    { sessionId: "synthetic-A", prompt: raw, delivery: "steer" },
    { sessionId: "synthetic-A", prompt: raw, delivery: "steer" }] },
  { name: "equal-text-distinct-sessions", inputs: [
    { sessionId: "synthetic-A", prompt: raw, delivery: "queue" },
    { sessionId: "synthetic-B", prompt: raw, delivery: "queue" }] },
  { name: "explicit-empty-string", inputs: [{ sessionId: "synthetic-A", prompt: "", delivery: "steer" }] },
  { name: "audit-normalization-is-separate", inputs: [{ sessionId: "synthetic-A", prompt: "  \u2013 \u2014 雪\r\n", delivery: "steer" }] },
  { name: "final-after-later-hook", inputs: [{ sessionId: "synthetic-A", prompt: raw }] },
  { name: "original-error-identity", inputs: [{ sessionId: "synthetic-A", prompt: raw }], reject: true },
  { name: "no-return-before-dependency", inputs: [{ sessionId: "synthetic-A", prompt: raw }], held: true },
];
export function controlsFor(scenario: Case): Fault[] {
  const controls: Fault[] = ["foreign-session", "duplicate-call", "missing-call"];
  if (!scenario.reject) controls.push("stale-result", "summary-result");
  if (scenario.inputs.some(input => input.prompt !== input.prompt.trim())) controls.push("trim-input");
  if (scenario.inputs.length === 2) controls.push("coalesce-equal");
  if (scenario.name === "explicit-empty-string") controls.push("drop-empty");
  if (scenario.reject) controls.push("swallow-error");
  if (scenario.held) controls.push("early-return");
  return controls;
}
export async function assertSendBoundary(scenario: Case, factory: Factory) {
  const journal: unknown[] = [], calls: { input: SendInput; original: SendInput; receiver: unknown }[] = [];
  const admissions: { captureId: string; input: SendInput }[] = [], delivered: unknown[] = [];
  // Scripted responses are independent dependency data, never expected assertion objects.
  const script = scenario.inputs.map((_, index) => ({
    final: { text: `  ## final-${index}\r\n\t雪 😀\n\n`, marker: `result-${index}`, usage: { inputTokens: index + 7 } },
    early: { text: `early-hook-${index}` },
    error: new Error(`synthetic original error-${index}`),
  }));
  const release = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  const inner: Sender = {
    async send(input) {
      const ordinal = calls.length;
      calls.push({ input: structuredClone(input), original: input, receiver: this });
      journal.push({ boundary: "inner-enter", ordinal, input: structuredClone(input) });
      const response = script[ordinal];
      assert.ok(response, "one dependency call per actual admission");
      if (scenario.held) { entered.resolve(); await release.promise; }
      if (scenario.reject) { journal.push({ boundary: "inner-error", ordinal }); throw response.error; }
      // An earlier observer saw different text. The completed dependency returns the later result.
      journal.push({ boundary: "earlier-hook", ordinal, text: response.early.text });
      journal.push({ boundary: "inner-return", ordinal, text: response.final.text });
      return response.final;
    },
  };
  const sender = factory(inner);
  try {
    for (const [ordinal, input] of scenario.inputs.entries()) {
      admissions.push({ captureId: `synthetic-capture-${ordinal}`, input: structuredClone(input) });
      journal.push({ boundary: "caller-admission", ordinal, input: structuredClone(input) });
      let settled = false;
      const pending = sender.send(input).then(
        value => { settled = true; delivered.push({ ordinal, value }); journal.push({ boundary: "caller-return", ordinal, text: value?.text }); return { value, error: undefined }; },
        error => { settled = true; journal.push({ boundary: "caller-error", ordinal }); return { value: undefined, error }; },
      );
      if (scenario.held) {
        try {
          await Promise.race([entered.promise, pending]);
          await Promise.resolve();
          assert.equal(settled, false, "public return is withheld while actual dependency is pending");
          assert.deepStrictEqual(delivered, [], "no caller delivery before dependency completion");
        } finally { release.resolve(); }
      }
      const outcome = await pending;
      if (scenario.reject) assert.strictEqual(outcome.error, script[ordinal].error, "preserve original error identity");
      else {
        assert.strictEqual(outcome.error, undefined, "valid response must not become an error");
        assert.strictEqual(outcome.value, script[ordinal].final, "return exact final dependency object after all dependency hooks");
        assert.equal(outcome.value?.text, `  ## final-${ordinal}\r\n\t雪 😀\n\n`, "full final text without summary or trimming");
      }
    }
    assert.equal(calls.length, scenario.inputs.length, "each actual ingress invokes the public dependency exactly once");
    for (const [ordinal, input] of scenario.inputs.entries()) {
      assert.deepStrictEqual(calls[ordinal].input, input, "captured complete request/session/delivery is unchanged");
      assert.strictEqual(calls[ordinal].original, input, "existing host forwarding preserves input identity");
      assert.strictEqual(calls[ordinal].receiver, inner, "preserve dependency receiver");
      assert.deepStrictEqual(admissions[ordinal].input, input, "admission captured before downstream processing");
    }
    assert.equal(new Set(admissions.map(item => item.captureId)).size, scenario.inputs.length, "identical text never collapses caller observations");
    return { name: scenario.name, journal, admissions, calls: calls.map(call => call.input), delivered,
      evidenceLevel: "isolated-public-send-boundary-only", nativeHost: false, providerExecuted: false, auditPersisted: false };
  } catch (error) {
    if (error instanceof assert.AssertionError) Object.assign(error, { interactionEvidence: structuredClone({ journal, admissions, calls: calls.map(call => call.input), delivered }) });
    throw error;
  } finally { release.resolve(); }
}

// SPDX-License-Identifier: Apache-2.0
// FR-QB-003 AC-QB-069 TEST-QB-069, partial recovery RPC forwarding.
// AC-QB-005/007/013 and UC-QB-003 steps5/31/32 remain open.
import assert from "node:assert/strict";
export type Request = { responseType: string; text?: string; images: string[]; files: string[] };
export type Input = { context: string; request: Request };
export type Callback = (context: string, text: string | undefined, images: string[], files: string[]) => Promise<void>;
export type Boundary = { configure(context: string, active: boolean): void; invoke(context: string, request: Request): Promise<unknown>; state(context: string): string | undefined };
export type Factory = (callback: Callback, warn: (message: string) => void) => Boundary;
export type Fault = "none" | "drop" | "duplicate" | "foreign" | "missing-state" | "late-state" | "trim" | "drop-images" | "drop-files" | "swap" | "undefined-to-empty" | "result-shape" | "early" | "swallow" | "execute-forbidden" | "mutate-forbidden-state" | "skip-warning";
type Case = { name: string; inputs: Input[]; active?: boolean; pending?: boolean; reject?: boolean; forwards: boolean };
const a = "synthetic-rpc-session-a", b = "synthetic-rpc-session-b";
const raw = "  ## recovery\r\n\t\u96ea \u{1f642} **request**\n\n";
const request = (responseType = "messageResponse"): Request => ({ responseType, text: raw, images: ["synthetic:image-a"], files: ["synthetic/file-a.ts"] });
export const cases: readonly Case[] = [
  { name: "message-response-raw-attachments", inputs: [{ context: a, request: request() }], forwards: true },
  { name: "approval-yes-raw-attachments", inputs: [{ context: a, request: request("yesButtonClicked") }], forwards: true },
  { name: "approval-no-raw-attachments", inputs: [{ context: a, request: request("noButtonClicked") }], forwards: true },
  { name: "empty-text-retains-attachments", inputs: [{ context: a, request: { ...request(), text: "" } }], forwards: true },
  { name: "absent-text-remains-undefined", inputs: [{ context: a, request: { responseType: "messageResponse", images: [], files: [] } }], forwards: true },
  { name: "inactive-task-does-not-forward", inputs: [{ context: a, request: request() }], active: false, forwards: false },
  { name: "invalid-rpc-type-does-not-enter-proxy", inputs: [{ context: a, request: request("synthetic-invalid-type") }], forwards: false },
  { name: "pending-handler-blocks-rpc-response", inputs: [{ context: a, request: request() }], pending: true, forwards: true },
  { name: "rejected-handler-preserves-error", inputs: [{ context: a, request: request() }], reject: true, forwards: true },
  { name: "equal-text-separate-contexts", inputs: [{ context: a, request: request() }, { context: b, request: request() }], forwards: true },
];
export function controlsFor(c: Case): Fault[] {
  if (!c.forwards) return ["execute-forbidden", "mutate-forbidden-state", "result-shape", "skip-warning"];
  const r = c.inputs[0].request;
  const out: Fault[] = ["drop", "duplicate", "foreign", "missing-state", "late-state"];
  if (!c.reject) out.push("result-shape");
  if (typeof r.text === "string" && r.text !== r.text.trim()) out.push("trim");
  if (r.images.length) out.push("drop-images");
  if (r.files.length) out.push("drop-files");
  if (r.images.length && r.files.length) out.push("swap");
  if (r.text === undefined) out.push("undefined-to-empty");
  if (c.pending) out.push("early");
  if (c.reject) out.push("swallow");
  return out;
}
export async function assertRecoveryRpc(c: Case, factory: Factory) {
  const calls: { context: string; responseState?: string; text?: string; images: string[]; files: string[] }[] = [];
  const journal: unknown[] = [], warnings: string[] = [], gates: ReturnType<typeof Promise.withResolvers<void>>[] = [];
  const outstanding: Promise<unknown>[] = [];
  const expectedStates = new Map<string, string | undefined>([[a, undefined], [b, undefined]]);
  const scriptError = new Error("synthetic RPC handler rejection");
  let gate: ReturnType<typeof Promise.withResolvers<void>>, observedSettled = false, sameError = false, result: unknown;
  const boundary = factory((context, text, images, files) => {
    const call = { context, responseState: boundary.state(context), text, images: [...images], files: [...files] };
    calls.push(call); journal.push({ effect: "handler", ...call }); return gate.promise;
  }, message => { warnings.push(message); journal.push({ effect: "warning", message }); });
  boundary.configure(a, c.active !== false); boundary.configure(b, true);
  try {
    for (const [index, input] of c.inputs.entries()) {
      gate = Promise.withResolvers<void>(); gates.push(gate); outstanding.push(gate.promise);
      if (!c.pending) { if (c.reject) gate.reject(scriptError); else gate.resolve(); }
      const returned = boundary.invoke(input.context, structuredClone(input.request)); outstanding.push(returned);
      observedSettled = false;
      returned.then(() => { observedSettled = true; }, () => { observedSettled = true; });
      assert.equal(calls.length, c.forwards ? index + 1 : 0, "rpc-call-count");
      if (c.forwards) {
        const call = calls[index], r = input.request;
        assert.equal(call.context, input.context, "rpc-target");
        assert.equal(call.responseState, r.responseType, "rpc-response-state");
        assert.equal(call.text, r.text, "rpc-raw-text");
        assert.deepStrictEqual(call.images, r.images, "rpc-images");
        assert.deepStrictEqual(call.files, r.files, "rpc-files");
        expectedStates.set(input.context, r.responseType);
      }
      if (c.pending) {
        await Promise.resolve(); await Promise.resolve();
        journal.push({ effect: "pending-response-check", settled: observedSettled });
        assert.equal(observedSettled, false, "rpc-pending-wait");
        gate.resolve();
      }
      let caught: unknown; result = undefined;
      try { result = await returned; } catch (error) { caught = error; }
      sameError = caught === (c.reject ? scriptError : undefined);
      journal.push({ effect: "result", result, sameError });
      assert.strictEqual(caught, c.reject ? scriptError : undefined, "rpc-handler-error");
      assert.equal(warnings.length, c.forwards ? 0 : index + 1, "rpc-warning-count");
      if (!c.reject) assert.deepStrictEqual(result, {}, "rpc-empty-result");
      for (const context of [a, b]) assert.strictEqual(boundary.state(context), expectedStates.get(context), "rpc-terminal-state");
    }
    return { name: c.name, calls, warnings, journal, level: "synthetic-recovery-rpc-boundary-only", nativeHost: false, durableAudit: false };
  } catch (error) {
    if (error instanceof assert.AssertionError) Object.assign(error, { interactionEvidence: {
      calls: structuredClone(calls), warnings: [...warnings], journal: structuredClone(journal),
      inputs: structuredClone(c.inputs), active: c.active !== false, expectedForward: c.forwards,
      pending: !!c.pending, reject: !!c.reject, observedSettled, sameError, result,
      states: [a, b].map(context => ({ context, state: boundary.state(context) })),
    } });
    throw error;
  } finally { for (const release of gates) release.resolve(); await Promise.allSettled(outstanding); }
}
export function qualify(error: unknown, fault: Fault): boolean {
  if (!(error instanceof assert.AssertionError)) return false;
  const e = (error as assert.AssertionError & { interactionEvidence?: {
    calls: { context: string; responseState?: string; text?: string; images: string[]; files: string[] }[];
    warnings: string[]; journal: unknown[]; inputs: Input[]; expectedForward: boolean;
    pending: boolean; reject: boolean; observedSettled: boolean; sameError: boolean; result: unknown;
    states: { context: string; state?: string }[];
  } }).interactionEvidence;
  if (!e || !Array.isArray(e.inputs) || !e.inputs.length || !Array.isArray(e.calls) || !Array.isArray(e.states) || !Array.isArray(e.warnings)) return false;
  const call = e.calls[0], input = e.inputs[0];
  const spec: Partial<Record<Fault, [string, string, boolean]>> = {
    drop: ["rpc-call-count", "strictEqual", e.expectedForward && e.calls.length === 0],
    duplicate: ["rpc-call-count", "strictEqual", e.expectedForward && e.calls.length === 2],
    foreign: ["rpc-target", "strictEqual", !!call && call.context !== input.context],
    "missing-state": ["rpc-response-state", "strictEqual", !!call && call.responseState === undefined && e.states.every(s => s.state === undefined)],
    "late-state": ["rpc-response-state", "strictEqual", !!call && call.responseState === undefined && e.states.some(s => s.context === input.context && s.state === input.request.responseType)],
    trim: ["rpc-raw-text", "strictEqual", !!call && typeof input.request.text === "string" && call.text === input.request.text.trim() && call.text !== input.request.text],
    "undefined-to-empty": ["rpc-raw-text", "strictEqual", !!call && input.request.text === undefined && call.text === ""],
    "drop-images": ["rpc-images", "deepStrictEqual", !!call && call.images.length === 0 && input.request.images.length > 0],
    "drop-files": ["rpc-files", "deepStrictEqual", !!call && call.files.length === 0 && input.request.files.length > 0],
    swap: ["rpc-images", "deepStrictEqual", !!call && JSON.stringify(call.images) === JSON.stringify(input.request.files) && JSON.stringify(input.request.images) !== JSON.stringify(input.request.files)],
    "result-shape": ["rpc-empty-result", "deepStrictEqual", !!e.result && Object.keys(e.result as object).length > 0],
    early: ["rpc-pending-wait", "strictEqual", e.pending && e.observedSettled],
    swallow: ["rpc-handler-error", "strictEqual", e.reject && !e.sameError],
    "execute-forbidden": ["rpc-call-count", "strictEqual", !e.expectedForward && e.calls.length > 0],
    "mutate-forbidden-state": ["rpc-terminal-state", "strictEqual", !e.expectedForward && e.states.some(s => s.state !== undefined)],
    "skip-warning": ["rpc-warning-count", "strictEqual", !e.expectedForward && e.warnings.length === 0],
  };
  const expected = spec[fault];
  return !!expected && error.message.split("\n", 1)[0] === expected[0] && error.operator === expected[1] && expected[2];
}


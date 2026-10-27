// SPDX-License-Identifier: Apache-2.0
/** Test-only capture fidelity contract. AC-QB-053/071; K18-BIND-007.
 * The adapter receives only a scripted dependency and an observation sink.
 * Scenario expectations never enter the adapter or the scripted dependency.
 */
import assert from "node:assert/strict";
export type Flags = { enumerable: boolean; configurable: boolean; writable: boolean };
export type Invocation = { receiver: "member" | "foreign" | "detached"; args: [string, { encoding: string; literal: string }] };
export type Reply = { kind: "return"; value: unknown } | { kind: "throw"; value: Error };
export type Input = { flags: Flags; invocations: Invocation[]; replies: Reply[]; foreign: object };
export type Scenario = { id: string; input: Input; expectedReceivers: string[]; expectedPhases: string[]; expectedJournal: string[] };
export type Member = ((...args: unknown[]) => unknown) & { native?: (...args: unknown[]) => unknown };
export type Emission = { phase: "call"; args: unknown[] } | { phase: "return" | "throw"; value: unknown };
export const faults = ["omit-native", "non-callable-native", "wrong-enumerable", "wrong-configurable", "wrong-writable", "wrong-receiver", "drop-argument", "wrong-path", "wrong-options", "clone-options", "wrong-result", "wrong-error", "omit-call", "duplicate-call", "reorder-calls", "omit-emission", "duplicate-emission", "reorder-emission", "mutate-input", "late-call-emission"] as const;
export type Fault = typeof faults[number];
export interface Adapter { bind(original: Member, emit: (event: Emission) => void, exercised: (fault: Fault) => void, fault?: Fault | "unrelated-crash"): Member }
export type Observation = {
  before: unknown; after: unknown;
  descriptor: { present: boolean; callable: boolean; enumerable?: boolean; configurable?: boolean; writable?: boolean; getter: boolean; setter: boolean };
  calls: { receiver: string; args: unknown[] }[];
  outcomes: { kind: "return" | "throw"; value: unknown }[];
  emissions: Emission[]; exercised: Fault[]; journal: string[];
};
export function snapshot(value: unknown): unknown {
  if (value instanceof Error) return { error: value.name, message: value.message, stack: value.stack, own: Object.fromEntries(Object.entries(value).map(([k, v]) => [k, snapshot(v)])) };
  if (ArrayBuffer.isView(value)) return { view: value.constructor.name, bytes: Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) };
  if (Array.isArray(value)) return value.map(snapshot);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, snapshot(v)]));
  return value;
}
/** One runner is reused later with the real test-only forwarding helper. */
export function runNativeMember(adapter: Adapter, input: Input, fault?: Fault | "unrelated-crash"): Observation {
  const before = snapshot(input), calls: Observation["calls"] = [], outcomes: Observation["outcomes"] = [], emissions: Emission[] = [], exercised: Fault[] = [], journal: string[] = [];
  let position = 0;
  const original: Member = function () { throw new Error("Unexpected main-function invocation"); };
  const native = function (this: unknown, ...args: unknown[]) {
    journal.push("native:call");
    calls.push({ receiver: this === original ? "original" : this === input.foreign ? "foreign" : this === undefined ? "undefined" : "other", args });
    try {
      const reply = input.replies[position++];
      if (!reply) throw new Error("Unscripted dependency invocation");
      if (reply.kind === "throw") throw reply.value;
      journal.push("native:return");
      return reply.value;
    } catch (error) { journal.push("native:throw"); throw error; }
  };
  Object.defineProperty(original, "native", { ...input.flags, value: native });
  // No input expectation, case id, expected outcome or expected event enters bind.
  const bound = adapter.bind(original, (event) => { journal.push("emit:" + event.phase); emissions.push(event); }, (value) => exercised.push(value), fault);
  const descriptor = Object.getOwnPropertyDescriptor(bound, "native");
  const observedDescriptor: Observation["descriptor"] = { present: !!descriptor, callable: typeof descriptor?.value === "function", getter: !!descriptor?.get, setter: !!descriptor?.set,
    ...(descriptor ? { enumerable: descriptor.enumerable, configurable: descriptor.configurable, writable: descriptor.writable } : {}) };
  for (const invocation of input.invocations) {
    // Missing/non-callable native remains an explicit descriptor assertion gap;
    // never count incidental TypeError as a successful negative control.
    if (typeof descriptor?.value !== "function") continue;
    const receiver = invocation.receiver === "member" ? bound : invocation.receiver === "foreign" ? input.foreign : undefined;
    try { outcomes.push({ kind: "return", value: Reflect.apply(descriptor.value, receiver, invocation.args) }); }
    catch (error) { outcomes.push({ kind: "throw", value: error }); }
  }
  return { before, after: snapshot(input), descriptor: observedDescriptor, calls, outcomes, emissions, exercised, journal };
}
export function assertNativeMember(actual: Observation, scenario: Scenario): void {
  const prefix = "NATIVE_MEMBER:";
  assert.deepStrictEqual(actual.after, actual.before, prefix + "input-immutability");
  assert.deepStrictEqual(actual.descriptor, { present: true, callable: true, getter: false, setter: false, ...scenario.input.flags }, prefix + "descriptor");
  assert.equal(actual.calls.length, scenario.input.invocations.length, prefix + "call-count");
  for (const [index, call] of actual.calls.entries()) {
    const intended = scenario.input.invocations[index]!;
    assert.equal(call.receiver, scenario.expectedReceivers[index], prefix + "receiver");
    assert.equal(call.args.length, intended.args.length, prefix + "argument-count");
    assert.strictEqual(call.args[0], intended.args[0], prefix + "literal-path-order");
    assert.strictEqual(call.args[1], intended.args[1], prefix + "options-identity");
  }
  assert.equal(actual.outcomes.length, scenario.input.replies.length, prefix + "outcome-count");
  for (const [index, outcome] of actual.outcomes.entries()) {
    const expected = scenario.input.replies[index]!;
    assert.equal(outcome.kind, expected.kind, prefix + "outcome-kind");
    assert.strictEqual(outcome.value, expected.value, prefix + (expected.kind === "throw" ? "error-identity" : "literal-result-identity"));
  }
  assert.deepStrictEqual(actual.emissions.map((event) => event.phase), scenario.expectedPhases, prefix + "emission-order-count");
  for (const [index, invocation] of scenario.input.invocations.entries()) {
    const start = actual.emissions[index * 2]!, end = actual.emissions[index * 2 + 1]!, expected = scenario.input.replies[index]!;
    assert.equal(start.phase, "call", prefix + "emitted-call");
    if (start.phase === "call") {
      assert.strictEqual(start.args[0], invocation.args[0], prefix + "emitted-path");
      assert.strictEqual(start.args[1], invocation.args[1], prefix + "emitted-options");
    }
    assert.equal(end.phase, expected.kind, prefix + "emitted-effect");
    if (end.phase !== "call") assert.strictEqual(end.value, expected.value, prefix + "emitted-value-identity");
  }
  assert.deepStrictEqual(actual.journal, scenario.expectedJournal, prefix + "cross-stream-order");
}
export function intendedRejection(error: unknown): boolean {
  return error instanceof assert.AssertionError && String(error.message).startsWith("NATIVE_MEMBER:");
}

// SPDX-License-Identifier: Apache-2.0
// P1 supporting inherited wrapper regression. Model/VM evidence cannot accept POSIX runtime.
import { strict as assert, AssertionError } from "node:assert";

export interface SignalInput {
  platform: "linux";
  wrapper: string;
  target: string;
  argv: string[];
  env: Record<string, string>;
  wrapperPid: number;
  childPid: number;
}
export interface ChildCompletion {
  error: "scripted-ENOENT" | null;
  status: number | null;
  signal: string | null;
}
export interface SignalScript {
  childCompletion: ChildCompletion;
  outerWrapperLaunchError?: "scripted-EACCES";
  readPid: number;
  killBehavior: "terminate-matching-root" | "return-without-root-termination" | "throw-scripted-ESRCH";
  signalDeliveries: number;
  spawnBehavior?: "throw-scripted-EAGAIN" | "terminate-root-before-spawn-return";
}
export interface Effect {
  kind: string;
  [key: string]: unknown;
}
export interface SignalObservation {
  result: { error: Error | undefined; status: number | null; signal: string | null };
  effects: Effect[];
  // Body of the selected model/adapter, never a claim of native wrapper execution.
  wrapperBodyEntered: boolean;
  receiverState: { wrapperPid: number; childPid: number; state: string; signal: string | null; status: number | null };
  scriptedErrors: Error[];
}
export interface SignalControl {
  id: string;
  patch: Partial<SignalScript>;
  intendedAssertion: string;
  operator: "strictEqual";
}
export const signalInput: SignalInput = {
  platform: "linux",
  wrapper: "/synthetic-c-signal/bin/cline",
  target: "/synthetic-c-signal/child.js",
  argv: ["/synthetic-c-signal/node", "/synthetic-c-signal/bin/cline"],
  env: { CLINE_BIN_PATH: "/synthetic-c-signal/child.js" },
  wrapperPid: 42001,
  childPid: 42002,
};
export const signalScript: SignalScript = {
  childCompletion: { error: null, status: null, signal: "SIGTERM" },
  readPid: 42001,
  killBehavior: "terminate-matching-root",
  signalDeliveries: 1,
};
export const signalControls: SignalControl[] = [
  { id: "wrong-child-signal", patch: { childCompletion: { error: null, status: null, signal: "SIGINT" } }, intendedAssertion: "original.signal", operator: "strictEqual" },
  { id: "missing-child-signal", patch: { childCompletion: { error: null, status: null, signal: null } }, intendedAssertion: "original.status", operator: "strictEqual" },
  { id: "numeric-status-wins-over-signal", patch: { childCompletion: { error: null, status: 7, signal: "SIGTERM" } }, intendedAssertion: "original.status", operator: "strictEqual" },
  { id: "spawn-error", patch: { childCompletion: { error: "scripted-ENOENT", status: null, signal: null } }, intendedAssertion: "original.status", operator: "strictEqual" },
  { id: "kill-returns", patch: { killBehavior: "return-without-root-termination" }, intendedAssertion: "original.status", operator: "strictEqual" },
  { id: "foreign-pid-read", patch: { readPid: 43001 }, intendedAssertion: "original.status", operator: "strictEqual" },
  { id: "known-kill-error", patch: { killBehavior: "throw-scripted-ESRCH" }, intendedAssertion: "original.status", operator: "strictEqual" },
  { id: "known-spawn-throw", patch: { spawnBehavior: "throw-scripted-EAGAIN" }, intendedAssertion: "original.status", operator: "strictEqual" },
  { id: "premature-root-signal", patch: { spawnBehavior: "terminate-root-before-spawn-return" }, intendedAssertion: "effects.kill-count", operator: "strictEqual" },
  { id: "duplicate-signal-delivery", patch: { signalDeliveries: 2 }, intendedAssertion: "effects.signal-count", operator: "strictEqual" },
  { id: "outer-wrapper-launch-error", patch: { outerWrapperLaunchError: "scripted-EACCES" }, intendedAssertion: "original.error", operator: "strictEqual" },
];
export function cloneInput(): SignalInput {
  return { ...signalInput, argv: [...signalInput.argv], env: { ...signalInput.env } };
}
export function scriptedResponses(patch: Partial<SignalScript> = {}): SignalScript {
  return { ...signalScript, ...patch, childCompletion: { ...(patch.childCompletion ?? signalScript.childCompletion) } };
}
export function assertBinSignal(observed: SignalObservation, input: SignalInput): void {
  // Exactly the original three predicates and operands, in original order.
  // Original Vitest expressions remain untouched in commands/bin-wrapper.test.ts.
  assert.equal(observed.result.error, undefined, "original.error");
  assert.equal(observed.result.status, null, "original.status");
  assert.equal(observed.result.signal, "SIGTERM", "original.signal");
  assert.equal(observed.wrapperBodyEntered, true, "effects.wrapper-body-entered");
  const spawns = observed.effects.filter((entry) => entry.kind === "spawn");
  assert.equal(spawns.length, 1, "effects.spawn-count");
  assert.equal(spawns[0]!.target, input.target, "effects.spawn-target");
  assert.deepEqual(spawns[0]!.args, input.argv.slice(2), "effects.spawn-args");
  assert.equal(spawns[0]!.stdio, "inherit", "effects.spawn-stdio");
  assert.deepEqual(spawns[0]!.env, { ...input.env, CLINE_WRAPPER_PATH: input.wrapper }, "effects.spawn-env");
  const kills = observed.effects.filter((entry) => entry.kind === "kill");
  assert.equal(kills.length, 1, "effects.kill-count");
  assert.equal(kills[0]!.pid, input.wrapperPid, "effects.kill-pid");
  assert.equal(kills[0]!.signal, "SIGTERM", "effects.kill-signal");
  const signals = observed.effects.filter((entry) => entry.kind === "root-signal");
  assert.equal(signals.length, 1, "effects.signal-count");
  assert.equal(signals[0]!.pid, input.wrapperPid, "effects.signal-pid");
  assert.equal(signals[0]!.signal, "SIGTERM", "effects.signal-value");
  const spawnIndex = observed.effects.findIndex((entry) => entry.kind === "spawn");
  const completionIndex = observed.effects.findIndex((entry) => entry.kind === "spawn-result");
  const killIndex = observed.effects.findIndex((entry) => entry.kind === "kill");
  const signalIndex = observed.effects.findIndex((entry) => entry.kind === "root-signal");
  assert.equal(spawnIndex < completionIndex && completionIndex < killIndex && killIndex < signalIndex, true, "effects.order");
  assert.equal(observed.effects.filter((entry) => entry.kind === "exit").length, 0, "effects.fallback-exit-count");
  assert.equal(observed.receiverState.wrapperPid, input.wrapperPid, "effects.receiver-pid");
  assert.equal(observed.receiverState.childPid, input.childPid, "effects.receiver-child");
  assert.equal(observed.receiverState.state, "signaled", "effects.receiver-state");
  assert.equal(observed.scriptedErrors.length, 0, "effects.unexpected-scripted-error");
}
export function qualifiesRejection(error: unknown, label: string, operator: string, history: SignalObservation | undefined): boolean {
  return error instanceof AssertionError &&
    error.message.split(/\r?\n/, 1)[0] === label &&
    error.operator === operator &&
    history !== undefined &&
    Array.isArray(history.effects) &&
    history.effects.length > 0 &&
    history.result !== undefined &&
    history.receiverState !== undefined;
}
export interface GuardResult {
  id: string;
  error: unknown;
  hasHistory: boolean;
  actualQualification: boolean;
}
export function classifierGuards(error: AssertionError, control: SignalControl, history: SignalObservation): GuardResult[] {
  const samples: [string, unknown, SignalObservation | undefined][] = [
    ["no-rejection", undefined, history],
    ["ordinary-error", new Error(control.intendedAssertion), history],
    ["wrong-assertion", new AssertionError({ actual: 0, expected: 1, operator: control.operator, message: "unrelated.assertion" }), history],
    ["wrong-operator", new AssertionError({ actual: 0, expected: 1, operator: "deepStrictEqual", message: control.intendedAssertion }), history],
    ["missing-history", error, undefined],
  ];
  const checked: GuardResult[] = [];
  for (const [id, sample, recorded] of samples) {
    const actualQualification = qualifiesRejection(sample, control.intendedAssertion, control.operator, recorded);
    assert.equal(actualQualification, false, "classifier.rejects-unqualified");
    checked.push({ id, error: sample, hasHistory: recorded !== undefined, actualQualification });
  }
  return checked;
}


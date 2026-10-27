// SPDX-License-Identifier: Apache-2.0
// FR-QB-002/003/005, partial AC-QB-005/013/014/069 and TEST-QB-005/013/014/069.
// Existing CLI factory control flow only. Native MCP/provider/governance remains open.
import assert from "node:assert/strict";

export type TurnInput = {
 prompt: string; mode?: string; userImages?: string[]; userFiles?: string[];
 delivery?: "queue" | "steer"; timeoutMs?: number;
};
export type SendInput = TurnInput & { sessionId: string | undefined };
export type StartInput = { resumeId?: string; initial: unknown[] };
export type Port = {
 start(input: StartInput): Promise<string>;
 readMessages(sessionId: string): Promise<unknown[]>;
 send(input: SendInput): Promise<unknown>;
 abort(sessionId: string): Promise<void>;
 getRow(sessionId: string): Promise<undefined>;
 getUsage(sessionId: string): Promise<undefined>;
 unsubscribe(kind: "agent" | "pending"): void;
 shutdownHooks(): Promise<void>;
 stop(sessionId: string): Promise<void>;
 dispose(reason: string): Promise<void>;
};
export type Boundary = {
 ensureReady(): Promise<void>;
 sendCurrentTurn(input: TurnInput): Promise<unknown>;
 abortAll(): boolean;
 resetForNewSession(): Promise<void>;
 cleanup(): Promise<unknown>;
 activeSessionId(): string | undefined;
};
export type Options = { cwd: string; resumeId?: string };
export type Factory = (options: Options, port: Port) => Boundary;
export type Fault =
 "none" | "trim" | "drop-images" | "drop-files" | "swap-attachments" |
 "wrong-target" | "missing-call" | "duplicate-call" | "wrong-result" |
 "discard-resume" | "missing-retry" | "retry-stale-session" |
 "read-wrong-context" | "reordered-recovery" | "swallow-error" |
 "wrong-error" | "unexpected-retry" | "foreign-send" | "early-settle" |
 "retry-after-abort" | "swallow-original-error" | "foreign-abort" |
 "early-dispose" | "double-dispose" | "missing-shutdown" |
 "reordered-shutdown-stop" | "delivery-after-shutdown" | "cross-target" |
 "late-result-crosslink" | "activate-obsolete" | "missing-stop-obsolete" |
 "stop-replacement" | "duplicate-replacement-start";
type Kind = "fresh" | "resume" | "recover" | "error" | "pending" | "abort" | "cleanup" | "two" | "reset";
export type Scenario = { name: string; kind: Kind; controls: readonly Fault[] };
const common: Fault[] = ["trim", "drop-images", "drop-files", "swap-attachments", "wrong-target", "missing-call", "duplicate-call", "wrong-result"];
export const scenarios: readonly Scenario[] = [
 { name: "fresh-send-raw-attachments", kind: "fresh", controls: [...common] },
 { name: "resume-send-captured-session", kind: "resume", controls: [...common, "discard-resume"] },
 { name: "missing-session-retry-same-input", kind: "recover", controls: [...common, "missing-retry", "retry-stale-session", "read-wrong-context", "reordered-recovery"] },
 { name: "ordinary-error-not-retried", kind: "error", controls: ["swallow-error", "wrong-error", "unexpected-retry", "foreign-send"] },
 { name: "pending-send-keeps-result-pending", kind: "pending", controls: ["early-settle", "wrong-result", "missing-call", "duplicate-call"] },
 { name: "abort-during-recovery-no-retry", kind: "abort", controls: ["retry-after-abort", "swallow-original-error", "foreign-abort"] },
 { name: "cleanup-waits-recovery-closes-once", kind: "cleanup", controls: ["early-dispose", "double-dispose", "missing-shutdown", "reordered-shutdown-stop", "delivery-after-shutdown"] },
 { name: "equal-input-two-runtime-instances", kind: "two", controls: ["cross-target", "late-result-crosslink", "missing-call", "duplicate-call", "wrong-result"] },
 { name: "reset-rejects-obsolete-start", kind: "reset", controls: ["activate-obsolete", "missing-stop-obsolete", "stop-replacement", "duplicate-replacement-start"] },
];
export type Event = { effect: string; root: string; value?: unknown };
type Evidence = { name: string; inputs: unknown[]; journal: Event[]; sends: SendInput[]; actual?: unknown };
function gate<T>() { return Promise.withResolvers<T>(); }
async function flush() { for (let i = 0; i < 24; i++) await Promise.resolve(); }
function capture(promise: Promise<unknown>, observe?: (state: { settled: boolean; result?: unknown; error?: unknown }) => void) {
 const state: { settled: boolean; result?: unknown; error?: unknown } = { settled: false };
 const done = promise.then(value => { state.result = value; state.settled = true; observe?.(state); },
 error => { state.error = error; state.settled = true; observe?.(state); });
 return { state, done };
}
// SAME scenario/input/interaction/assertion runner for Mock and later unchanged public factory.
// The factory receives operation inputs and dependency callbacks only, never expected values.
export async function assertInteractiveRecovery(scenario: Scenario, factory: Factory) {
 const journal: Event[] = [], inputs: unknown[] = [], sends: SendInput[] = [];
 const outstanding: Promise<unknown>[] = [], gates: ReturnType<typeof gate<unknown>>[] = [];
 const raw: TurnInput = { prompt: "  ## recovery\r\n\t\u96ea \u{1f642} **raw**\n\n",
  mode: "act", userImages: ["synthetic:image/a", "synthetic:image/b"],
  userFiles: ["synthetic/file-a.ts"], delivery: "steer", timeoutMs: 321 };
 const savedMessages = [{ role: "user", text: "synthetic prior\r\ncontext" }];
 const missing = Object.assign(new Error("synthetic missing session"), { missingSession: true });
 const ordinary = new Error("synthetic original send error");
 const sendGate = gate<unknown>(), readGate = gate<unknown>(), startGate = gate<unknown>();
 gates.push(sendGate, readGate, startGate);
 const observed: Record<string, { starts: StartInput[]; stops: string[]; aborts: string[]; closes: string[]; sends: SendInput[] }> = {};
 const make = (root: string, resumeId?: string) => {
  const calls = { starts: [] as StartInput[], stops: [] as string[], aborts: [] as string[], closes: [] as string[], sends: [] as SendInput[] };
  observed[root] = calls;
  const result = { root, content: "synthetic independent dependency result" };
  const port: Port = {
   async start(input) {
    calls.starts.push(structuredClone(input)); journal.push({ effect: "start", root, value: structuredClone(input) });
    const number = calls.starts.length;
    if (scenario.kind === "reset" && number === 1) await startGate.promise;
    const id = input.resumeId ?? root + "/session-" + number;
    journal.push({ effect: "start-return", root, value: id }); return id;
   },
   async readMessages(id) {
    journal.push({ effect: "read", root, value: id });
    if (scenario.kind === "abort" || scenario.kind === "cleanup") await readGate.promise;
    journal.push({ effect: "read-return", root, value: structuredClone(savedMessages) });
    return structuredClone(savedMessages);
   },
   async send(input) {
    const copy = structuredClone(input); calls.sends.push(copy); sends.push(copy);
    journal.push({ effect: "send", root, value: copy });
    if (scenario.kind === "error") throw ordinary;
    if (["recover", "abort", "cleanup"].includes(scenario.kind) && calls.sends.length === 1) throw missing;
    if (scenario.kind === "pending" || scenario.kind === "two") await sendGate.promise;
    journal.push({ effect: "send-return", root, value: result }); return result;
   },
   async abort(id) { calls.aborts.push(id); journal.push({ effect: "abort", root, value: id }); },
   async getRow(id) { journal.push({ effect: "get-row", root, value: id }); return undefined; },
   async getUsage(id) { journal.push({ effect: "get-usage", root, value: id }); return undefined; },
   unsubscribe(kind) { journal.push({ effect: "unsubscribe-" + kind, root }); },
   async shutdownHooks() { journal.push({ effect: "hooks-shutdown", root }); },
   async stop(id) { calls.stops.push(id); journal.push({ effect: "stop", root, value: id }); },
   async dispose(reason) { calls.closes.push(reason); journal.push({ effect: "dispose", root, value: reason }); },
  };
  const options = { cwd: root, ...(resumeId ? { resumeId } : {}) }; inputs.push(options);
  return { boundary: factory(options, port), calls, result, root };
 };
 const aRoot = "synthetic-task-owned/interactive-a", bRoot = "synthetic-task-owned/interactive-b";
 const a = make(aRoot, scenario.kind === "resume" ? aRoot + "/remembered" : undefined);
 const turnInput = () => { const copy = structuredClone(raw); inputs.push(copy); return copy; };
 let actual: unknown;
 try {
  if (scenario.kind === "reset") {
   const oldReady = a.boundary.ensureReady(); outstanding.push(oldReady); await flush();
   assert.equal(a.calls.starts.length, 1, "interactive-start-count");
   await a.boundary.resetForNewSession();
   const newReady = a.boundary.ensureReady(); outstanding.push(newReady); await flush();
   assert.equal(a.calls.starts.length, 2, "interactive-replacement-count");
   await newReady; startGate.resolve(undefined); await oldReady;
   assert.equal(a.boundary.activeSessionId(), aRoot + "/session-2", "interactive-active-generation");
   assert.deepStrictEqual(a.calls.stops, [aRoot + "/session-1"], "interactive-obsolete-stop");
   actual = { active: a.boundary.activeSessionId(), stops: a.calls.stops };
  } else {
   const ready = a.boundary.ensureReady(); outstanding.push(ready); await ready;
   assert.equal(a.calls.starts.length, 1, "interactive-start-count");
   assert.equal(a.calls.starts[0].resumeId, scenario.kind === "resume" ? aRoot + "/remembered" : undefined, "interactive-resume-input");
   const firstId = scenario.kind === "resume" ? aRoot + "/remembered" : aRoot + "/session-1";
   assert.equal(a.boundary.activeSessionId(), firstId, "interactive-active-session");
   const sent = capture(a.boundary.sendCurrentTurn(turnInput()), state => journal.push({
    effect: "boundary-terminal", root: aRoot, value: { result: state.result,
     errorMessage: state.error instanceof Error ? state.error.message : undefined,
     sameMissingError: state.error === missing, sameOrdinaryError: state.error === ordinary } })); outstanding.push(sent.done);
   await flush();
   if (scenario.kind === "pending") {
    assert.equal(a.calls.sends.length, 1, "interactive-send-count");
    assert.equal(sent.state.settled, false, "interactive-pending-wait");
    sendGate.resolve(undefined);
   }
   if (scenario.kind === "abort" || scenario.kind === "cleanup") {
    assert.equal(journal.filter(e => e.effect === "read").length, 1, "interactive-recovery-read-count");
    if (scenario.kind === "abort") {
     assert.equal(a.boundary.abortAll(), true, "interactive-abort-admitted");
     assert.deepStrictEqual(a.calls.aborts, [firstId], "interactive-abort-target");
    } else {
     const first = capture(a.boundary.cleanup()), second = capture(a.boundary.cleanup());
     outstanding.push(first.done, second.done); await flush();
     assert.equal(first.state.settled || second.state.settled, false, "interactive-cleanup-wait");
     assert.deepStrictEqual(a.calls.closes, [], "interactive-no-early-dispose");
     readGate.resolve(undefined);
     await sent.done; await first.done; await second.done;
     assert.strictEqual(first.state.error, undefined, "interactive-cleanup-error");
     assert.strictEqual(second.state.error, undefined, "interactive-cleanup-error");
     const summary = { sessionId: aRoot + "/session-2", startedAt: undefined, provider: undefined,
      model: undefined, cwd: undefined, messageCount: savedMessages.length };
     assert.deepStrictEqual(first.state.result, summary, "interactive-cleanup-summary");
     assert.strictEqual(second.state.result, first.state.result, "interactive-cleanup-shared-result");
     assert.deepStrictEqual(a.calls.closes, ["cli_interactive_shutdown"], "interactive-dispose-once");
     const effects = journal.map(e => e.effect);
     assert.equal(effects.filter(e => e === "hooks-shutdown").length, 1, "interactive-hooks-once");
     assert.equal(effects.indexOf("hooks-shutdown") < effects.indexOf("stop"), true, "interactive-shutdown-order");
     const cleanupEffects = journal.filter(e => ["unsubscribe-agent", "unsubscribe-pending", "get-row", "get-usage", "hooks-shutdown", "stop", "dispose"].includes(e.effect));
     assert.deepStrictEqual(cleanupEffects.map(e => e.effect),
      ["unsubscribe-agent", "unsubscribe-pending", "get-row", "get-usage", "hooks-shutdown", "stop", "dispose"], "interactive-cleanup-effects");
     for (const effect of cleanupEffects.filter(e => ["get-row", "get-usage", "stop"].includes(e.effect))) {
      assert.equal(effect.value, aRoot + "/session-2", "interactive-cleanup-context");
     }
    }
    readGate.resolve(undefined);
   }
   if (scenario.kind === "two") {
    const b = make(bRoot); const readyB = b.boundary.ensureReady(); outstanding.push(readyB); await readyB;
    const sentB = capture(b.boundary.sendCurrentTurn(turnInput()), state => journal.push({
     effect: "boundary-terminal", root: bRoot, value: { result: state.result,
      errorMessage: state.error instanceof Error ? state.error.message : undefined,
      sameMissingError: state.error === missing, sameOrdinaryError: state.error === ordinary } })); outstanding.push(sentB.done);
    await flush();
    assert.equal(a.calls.sends.length, 1, "interactive-send-count");
    assert.equal(b.calls.sends.length, 1, "interactive-send-count");
    assert.equal(sent.state.settled || sentB.state.settled, false, "interactive-pending-wait");
    sendGate.resolve(undefined); await sent.done; await sentB.done;
    assert.equal(b.calls.sends.length, 1, "interactive-send-count");
    assert.equal(b.calls.sends[0].sessionId, bRoot + "/session-1", "interactive-send-target");
    assert.equal(b.calls.sends[0].prompt, raw.prompt, "interactive-raw-prompt");
    assert.deepStrictEqual(b.calls.sends[0].userImages, raw.userImages, "interactive-images");
    assert.deepStrictEqual(b.calls.sends[0].userFiles, raw.userFiles, "interactive-files");
    assert.equal(b.calls.sends[0].mode, raw.mode, "interactive-mode");
    assert.equal(b.calls.sends[0].delivery, raw.delivery, "interactive-delivery");
    assert.equal(b.calls.sends[0].timeoutMs, raw.timeoutMs, "interactive-timeout-input");
    assert.strictEqual(sentB.state.result, b.result, "interactive-result-identity");
   }
   await sent.done;
   const recovery = ["recover", "abort", "cleanup"].includes(scenario.kind);
   const blocked = scenario.kind === "abort" || scenario.kind === "cleanup";
   const count = scenario.kind === "recover" ? 2 : 1;
   assert.equal(a.calls.sends.length, count, "interactive-send-count");
   for (const [index, call] of a.calls.sends.entries()) {
    assert.equal(call.sessionId, index === 0 ? firstId : aRoot + "/session-2", "interactive-send-target");
    assert.equal(call.prompt, raw.prompt, "interactive-raw-prompt");
    assert.deepStrictEqual(call.userImages, raw.userImages, "interactive-images");
    assert.deepStrictEqual(call.userFiles, raw.userFiles, "interactive-files");
    assert.equal(call.mode, raw.mode, "interactive-mode");
    assert.equal(call.delivery, raw.delivery, "interactive-delivery");
    assert.equal(call.timeoutMs, raw.timeoutMs, "interactive-timeout-input");
   }
   const reads = journal.filter(e => e.effect === "read");
   const expectedReads = scenario.kind === "cleanup" ? 2 : recovery || scenario.kind === "resume" ? 1 : 0;
   assert.equal(reads.length, expectedReads, "interactive-recovery-read-count");
   if (scenario.kind === "resume") {
    assert.equal(reads[0].value, firstId, "interactive-resume-read-target");
    assert.deepStrictEqual(a.calls.starts[0].initial, savedMessages, "interactive-resume-context");
   }
   if (scenario.kind === "cleanup") assert.equal(reads[1].value, aRoot + "/session-2", "interactive-cleanup-read-target");
   if (recovery) {
    assert.equal(reads[0].value, firstId, "interactive-recovery-read-target");
    assert.equal(a.calls.starts.length, 2, "interactive-recovery-start-count");
    assert.deepStrictEqual(a.calls.starts[1].initial, savedMessages, "interactive-recovery-context");
    const effects = journal.map(e => e.effect);
    assert.equal(effects.indexOf("read-return") < effects.lastIndexOf("start"), true, "interactive-recovery-order");
   }
   const expectedError = scenario.kind === "error" ? ordinary : blocked ? missing : undefined;
   assert.strictEqual(sent.state.error, expectedError, "interactive-original-error");
   if (!expectedError) assert.strictEqual(sent.state.result, a.result, "interactive-result-identity");
   actual = { resultIdentity: sent.state.result === a.result, originalError: sent.state.error === expectedError, active: a.boundary.activeSessionId() };
  }
  return { name: scenario.name, inputs, journal, sends, actual };
 } catch (error) {
  if (error instanceof Error) Object.assign(error, { interactionEvidence: { name: scenario.name, inputs, journal, sends, actual } satisfies Evidence });
  throw error;
 } finally {
  for (const pending of gates) pending.resolve(undefined);
  await Promise.allSettled(outstanding);
 }
}
const labels: Partial<Record<Fault, string>> = {
 "trim": "interactive-raw-prompt", "drop-images": "interactive-images",
 "drop-files": "interactive-files", "swap-attachments": "interactive-images",
 "wrong-target": "interactive-send-target", "cross-target": "interactive-send-target",
 "missing-call": "interactive-send-count", "duplicate-call": "interactive-send-count",
 "wrong-result": "interactive-result-identity", "late-result-crosslink": "interactive-result-identity",
 "discard-resume": "interactive-resume-input", "missing-retry": "interactive-send-count",
 "retry-stale-session": "interactive-send-target", "read-wrong-context": "interactive-recovery-read-target",
 "reordered-recovery": "interactive-recovery-context", "swallow-error": "interactive-original-error",
 "wrong-error": "interactive-original-error", "unexpected-retry": "interactive-send-count",
 "foreign-send": "interactive-send-target", "early-settle": "interactive-pending-wait",
 "retry-after-abort": "interactive-send-count", "swallow-original-error": "interactive-original-error",
 "foreign-abort": "interactive-abort-target", "early-dispose": "interactive-no-early-dispose",
 "double-dispose": "interactive-dispose-once", "missing-shutdown": "interactive-hooks-once",
 "reordered-shutdown-stop": "interactive-shutdown-order", "delivery-after-shutdown": "interactive-send-count",
 "activate-obsolete": "interactive-active-generation", "missing-stop-obsolete": "interactive-obsolete-stop",
 "stop-replacement": "interactive-obsolete-stop", "duplicate-replacement-start": "interactive-replacement-count",
};
export function qualify(error: unknown, scenario: Scenario, fault: Fault): boolean {
 if (!(error instanceof assert.AssertionError)) return false;
 const label = error.message.split("\n", 1)[0];
 if (label !== labels[fault]) return false;
 const expectedOperator = ["interactive-images", "interactive-files", "interactive-recovery-context", "interactive-obsolete-stop",
  "interactive-abort-target", "interactive-no-early-dispose", "interactive-dispose-once"].includes(label) ? "deepStrictEqual" : "strictEqual";
 if (error.operator !== expectedOperator) return false;
 const evidence = (error as assert.AssertionError & { interactionEvidence?: Evidence }).interactionEvidence;
 return evidence?.name === scenario.name && Array.isArray(evidence.inputs) && evidence.inputs.length >= 1 &&
  Array.isArray(evidence.journal) && evidence.journal.some(e => e.effect === "start") && Array.isArray(evidence.sends);
}


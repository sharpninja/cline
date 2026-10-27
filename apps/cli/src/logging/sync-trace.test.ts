import { describe, expect, it } from "vitest";
import { createSynchronousTrace, type TraceEvent } from "./sync-trace.test-support";

type Fault = "none" | "drop" | "double" | "args" | "this" | "return" | "swallow" | "replace-error" | "drop-after" | "reverse-events";
const input = { label: "owned diagnostic input" };
const receiver = { label: "owned diagnostic receiver" };
const result = { label: "scripted return identity" };
const originalError = Object.assign(new Error("scripted syscall error"), { code: "EACCES" });
const sinkError = new Error("scripted trace descriptor failure");
function run(throws: boolean, sinkThrows: boolean, fault: Fault = "none") {
 const calls: { receiver: unknown; args: unknown[] }[] = [];
 const events: TraceEvent[] = [];
 const trace = createSynchronousTrace(event => {
  if (sinkThrows) throw sinkError;
  if (fault === "drop-after" && event.phase === "after") return;
  if (fault === "reverse-events") events.unshift(event); else events.push(event);
 });
 function original(this: unknown, ...args: unknown[]) {
  calls.push({ receiver: this, args });
  if (throws) throw originalError;
  return result;
 }
 const wrapped = trace.wrap("writeSync", original);
 let returned: unknown;
 let error: unknown;
 try {
  if (fault === "drop") returned = undefined;
  else if (fault === "double") { wrapped.call(receiver, input, 7); returned = wrapped.call(receiver, input, 7); }
  else if (fault === "args") returned = wrapped.call(receiver, 7, input);
  else if (fault === "this") returned = wrapped.call({}, input, 7);
  else if (fault === "return") { wrapped.call(receiver, input, 7); returned = {}; }
  else if (fault === "swallow") { try { returned = wrapped.call(receiver, input, 7); } catch { returned = result; } }
  else if (fault === "replace-error") { try { returned = wrapped.call(receiver, input, 7); } catch { throw new Error("replacement"); } }
  else returned = wrapped.call(receiver, input, 7);
 } catch (caught) { error = caught; }
 return { returned, error, calls, events, failures: trace.failures };
}
function assertForwarding(observed: ReturnType<typeof run>, throws: boolean, sinkThrows: boolean) {
 expect(observed.calls).toHaveLength(1);
 expect(observed.calls[0].receiver).toBe(receiver);
 expect(observed.calls[0].args).toHaveLength(2);
 expect(observed.calls[0].args[0]).toBe(input);
 expect(observed.calls[0].args[1]).toBe(7);
 expect(observed.returned).toBe(throws ? undefined : result);
 expect(observed.error).toBe(throws ? originalError : undefined);
 expect(observed.failures).toHaveLength(sinkThrows ? 2 : 0);
 for (const failure of observed.failures) expect(failure).toBe(sinkError);
 expect(observed.events).toEqual(sinkThrows ? [] : [
  { operation: "writeSync", phase: "before" },
  throws ? { operation: "writeSync", phase: "error", errorCode: "EACCES" } : { operation: "writeSync", phase: "after" },
 ]);
}
function assertRun(throws: boolean, sinkThrows: boolean, fault: Fault = "none") {
 const observed = run(throws, sinkThrows, fault);
 console.info(`C_LOGGING_TRACE_MOCK ${JSON.stringify({ throws, sinkThrows, fault, calls: observed.calls.length, events: observed.events, traceFailures: observed.failures.length, returnedOriginal: observed.returned === result, errorOriginal: observed.error === originalError })}`);
 assertForwarding(observed, throws, sinkThrows);
}
describe("diagnostic synchronous trace preserves actual operation semantics", () => {
 for (const throws of [false, true]) for (const sinkThrows of [false, true]) it(`forwards original throws=${throws} traceSinkThrows=${sinkThrows}`, () => assertRun(throws, sinkThrows));
 for (const fault of ["drop", "double", "args", "this", "return", "drop-after", "reverse-events"] as const) it(`same assertions reject actual ${fault} behavior`, () => { expect(() => assertRun(false, false, fault)).toThrowError(expect.objectContaining({ name: "AssertionError" })); });
 for (const fault of ["swallow", "replace-error"] as const) it(`same assertions reject actual ${fault} exception behavior`, () => { expect(() => assertRun(true, false, fault)).toThrowError(expect.objectContaining({ name: "AssertionError" })); });
});

import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => {
 const state = { calls: [] as { operation: string; receiver: unknown; args: unknown[] }[], events: [] as { operation: string; phase: string }[], response: undefined as unknown, error: undefined as unknown, sinkFails: false };
 const target = (operation: string) => function(this: unknown, ...args: unknown[]) {
  state.calls.push({ operation, receiver: this, args });
  if (state.error) throw state.error;
  return state.response;
 };
 const write = target("fs.writeSync");
 const stream = { write: target("stream.write"), flushSync() {}, flush() {}, end() {} };
 const filesystem = {
  openSync() { return 97; }, closeSync() {}, mkdirSync() {}, statSync() {}, truncateSync() {},
  writeSync(this: unknown, ...args: unknown[]) {
   if (args[0] === 97) {
    if (state.sinkFails) throw new Error("scripted trace sink failure");
    state.events.push(JSON.parse(String(args[1])));
    return String(args[1]).length;
   }
   return Reflect.apply(write, this, args);
  },
 };
 const destination = function(this: unknown, ...args: unknown[]) {
  state.calls.push({ operation: "pino.destination", receiver: this, args });
  return stream;
 };
 const logger = { destination };
 return { state, stream, filesystem, logger, originalWrite: filesystem.writeSync, originalDestination: destination };
});
vi.mock("node:fs", () => ({ default: fixture.filesystem }));
vi.mock("node:module", () => ({ syncBuiltinESMExports() {} }));
vi.mock("pino", () => ({ default: fixture.logger }));
import { beginLoggingTrace, finishLoggingTrace } from "./adapter-trace.test-support";

type Operation = "fs" | "stream";
type Fault = "none" | "wrong-return" | "wrong-error" | "omit" | "double" | "wrong-this" | "wrong-args" | "wrong-destination-this" | "wrong-destination-args";
const originalError = Object.assign(new Error("scripted dependency error"), { code: "EACCES" });
const receiver = { synthetic: "receiver-canary" };
const args = [23, "synthetic-payload"];
const syntheticRoot = join(tmpdir(), "cline-c-attachment-synthetic");
const destinationInput = { dest: join(syntheticRoot, "product.log"), sync: true };

// The attachment receives only operation inputs and scripted dependency outcomes.
// The assertions below use independent required forwarding values and actual effects.
function observe(operation: Operation, throws: boolean, sinkFails: boolean, fault: Fault) {
 const state = fixture.state;
 state.calls = []; state.events = []; state.sinkFails = false;
 state.response = fault === "wrong-return" ? "wrong-provider-result" : operation === "fs" ? 7 : false;
 state.error = throws ? fault === "wrong-error" ? new Error("different-provider-error") : originalError : undefined;
 const previous = [process.env.CLINE_LOG_DIAGNOSTIC_ROOT, process.env.CLINE_LOG_DIAGNOSTIC_TRACE];
 process.env.CLINE_LOG_DIAGNOSTIC_ROOT = syntheticRoot;
 process.env.CLINE_LOG_DIAGNOSTIC_TRACE = join(syntheticRoot, "boundaries.jsonl");
 let result: unknown;
 let error: unknown;
 let destinationResult: unknown;
 try {
  beginLoggingTrace("independent attachment fixture");
  if (operation === "stream") destinationResult = Reflect.apply(pino.destination, fault === "wrong-destination-this" ? {} : pino, fault === "wrong-destination-args" ? [] : [destinationInput]);
  const fn = operation === "fs" ? fs.writeSync : (destinationResult as typeof fixture.stream).write;
  state.sinkFails = sinkFails;
  const invoke = () => Reflect.apply(fn, fault === "wrong-this" ? {} : receiver, fault === "wrong-args" ? ["changed-input"] : args);
  try { if (fault !== "omit") result = invoke(); if (fault === "double") result = invoke(); } catch (caught) { error = caught; }
 } finally {
  state.sinkFails = false;
  vi.restoreAllMocks();
  finishLoggingTrace();
  for (const [index, key] of ["CLINE_LOG_DIAGNOSTIC_ROOT", "CLINE_LOG_DIAGNOSTIC_TRACE"].entries()) {
   const value = previous[index]; if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
 }
 console.log("C_LOGGING_ATTACHMENT_MOCK " + JSON.stringify({ operation, throws, sinkFails, fault, result, originalError: error === originalError, calls: state.calls.map(call => ({ operation: call.operation, receiver: call.receiver, args: call.args })), events: state.events }));
 return { result, error, destinationResult, calls: state.calls, events: state.events };
}
function assertForwarding(operation: Operation, throws: boolean, sinkFails: boolean, observed: ReturnType<typeof observe>) {
 const calls = observed.calls;
 expect(calls.map(call => call.operation)).toEqual(operation === "fs" ? ["fs.writeSync"] : ["pino.destination", "stream.write"]);
 if (operation === "stream") {
  expect(calls[0]!.receiver).toBe(pino);
  expect(calls[0]!.args).toEqual([destinationInput]);
  expect(observed.destinationResult).toBe(fixture.stream);
 }
 const target = calls.at(-1)!;
 expect(target.receiver).toBe(receiver);
 expect(target.args).toEqual(args);
 expect(observed.error).toBe(throws ? originalError : undefined);
 expect(observed.result).toBe(throws ? undefined : operation === "fs" ? 7 : false);
 expect(fs.writeSync).toBe(fixture.originalWrite);
 expect(pino.destination).toBe(fixture.originalDestination);
 expect(observed.events.some(event => event.operation === `trace.sinkFailures:${sinkFails ? 2 : 0}`)).toBe(true);
 const boundary = operation === "fs" ? "fs.writeSync" : "destination.write";
 expect(observed.events.filter(event => event.operation === boundary).map(event => event.phase)).toEqual(sinkFails ? [] : ["before", throws ? "error" : "after"]);
}

describe("released logging attachment independent dependency effects", () => {
 for (const operation of ["fs", "stream"] as const) {
  for (const throws of [false, true]) {
   it(`${operation} forwards exact receiver/args/${throws ? "error" : "return"}`, () => {
    assertForwarding(operation, throws, false, observe(operation, throws, false, "none"));
   });
  }
  it(`${operation} retains original outcome when trace sink throws`, () => {
   assertForwarding(operation, false, true, observe(operation, false, true, "none"));
  });
  for (const fault of [...["wrong-return", "wrong-error", "omit", "double", "wrong-this", "wrong-args"] as const, ...(operation === "stream" ? ["wrong-destination-this", "wrong-destination-args"] as const : [])]) {
   it(`${operation} rejects actual ${fault} interaction through same assertions`, () => {
    const throws = fault === "wrong-error";
    expect(() => assertForwarding(operation, throws, false, observe(operation, throws, false, fault))).toThrow();
   });
  }
 }
});
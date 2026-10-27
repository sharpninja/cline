// Test-only attachment released by O-C-LOGGING-INSTRUMENTATION-RELEASE-001.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { isAbsolute, resolve } from "node:path";
import pino from "pino";
import { vi } from "vitest";
import { createSynchronousTrace, type TraceEvent } from "./sync-trace.test-support";

const originalOpen = fs.openSync;
const originalWrite = fs.writeSync;
const originalClose = fs.closeSync;
let descriptor: number | undefined;
let taskName = "";
let sequence = 0;
let active: ReturnType<typeof createSynchronousTrace> | undefined;

function emit(event: TraceEvent): void {
 if (descriptor === undefined) return;
 const line = JSON.stringify({ sequence: ++sequence, task: taskName, ...event }) + "\n";
 Reflect.apply(originalWrite, fs, [descriptor, line]);
}

export function beginLoggingTrace(name: string): void {
 const path = process.env.CLINE_LOG_DIAGNOSTIC_TRACE;
 if (!path) return;
 const ownedRoot = process.env.CLINE_LOG_DIAGNOSTIC_ROOT;
 if (!ownedRoot || !isAbsolute(path) || !resolve(path).startsWith(resolve(ownedRoot) + "/") && !resolve(path).startsWith(resolve(ownedRoot) + "\\")) {
  throw new Error("Logging trace must use an absolute task-owned path");
 }
 taskName = name;
 descriptor = Reflect.apply(originalOpen, fs, [path, "a"]);
 active = createSynchronousTrace(emit);
 emit({ operation: "test", phase: "before" });
 for (const key of ["openSync", "closeSync", "writeSync", "mkdirSync", "statSync", "truncateSync"] as const) {
  const original = fs[key];
  // All installed overloads retain their original receiver, arguments and outcomes.
  vi.spyOn(fs, key).mockImplementation(active.wrap(`fs.${key}`, original) as never);
 }
 syncBuiltinESMExports();
 const destination = active.wrap("pino.destination", pino.destination);
 vi.spyOn(pino, "destination").mockImplementation(function(this: unknown, ...args: Parameters<typeof pino.destination>) {
  const stream = Reflect.apply(destination, this, args);
  for (const key of ["write", "flushSync", "flush", "end"] as const) {
   if (typeof stream[key] === "function") {
    const original = stream[key];
    vi.spyOn(stream, key).mockImplementation(active!.wrap(`destination.${key}`, original) as never);
   }
  }
  return stream;
 });
}

export function markLoggingTrace(operation: string, phase: TraceEvent["phase"]): void {
 if (active) emit({ operation, phase });
}

export function finishLoggingTrace(): void {
 if (!active) return;
 // Called after the original vi.restoreAllMocks, so native named exports follow restoration.
 syncBuiltinESMExports();
 emit({ operation: `trace.sinkFailures:${active.failures.length}`, phase: "after" });
 emit({ operation: "test", phase: "after" });
 const fd = descriptor;
 active = undefined;
 descriptor = undefined;
 if (fd !== undefined) Reflect.apply(originalClose, fs, [fd]);
}

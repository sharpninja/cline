// Test-only scripted filesystem/provider boundary. Never receives expected outcomes.
export type Script = { kind: "file" | "directory"; fail?: "mkdir" | "open" | "stat" | "close" | "destination"; missingStat?: boolean };
export type Input = { path: string; message: string; enabled: boolean; runtime?: "cli" | "rpc-runtime" };
export type Fault = "none" | "omit-stat" | "ignore-directory" | "omit-close" | "double-close" | "early-close" | "wrong-fd" | "wrong-path" | "async-stream" | "wrong-message" | "omit-write" | "omit-flush" | "omit-end" | "allocate-disabled" | "wrong-fallback";
export function createBoundary(script: Script) {
 const effects: unknown[][] = [];
 const descriptors: { id: number; closed: boolean; closeCount: number }[] = [];
 const output: { channel: string; text: string }[] = [];
 let admittedPath = "";
 function fail(operation: Script["fail"]) { if (script.fail === operation) throw new Error(`scripted:${operation}`); }
 function descriptor(fd: number) { const d = descriptors.find(x => x.id === fd); if (!d || d.closed) throw new Error("invalid descriptor"); return d; }
 const boundary = {
  effects, descriptors, output,
  mkdir(path: string, options: { recursive: boolean }) { effects.push(["mkdir", path, options]); fail("mkdir"); },
  open(path: string, flags: string) { effects.push(["open", path, flags]); fail("open"); admittedPath = path; descriptors.push({ id: 71, closed: false, closeCount: 0 }); return 71; },
  stat(fd: number) { effects.push(["fstat", fd]); descriptor(fd); if (script.fail === "stat") { effects.push(["fstat-error", "scripted:stat"]); fail("stat"); } if (script.missingStat) { effects.push(["fstat-result", "missing"]); return undefined; } effects.push(["fstat-result", script.kind]); return { isDirectory: () => script.kind === "directory" }; },
  close(fd: number) { effects.push(["close", fd]); const d = descriptor(fd); d.closeCount++; fail("close"); d.closed = true; },
  destination(options: { dest: string | number; mkdir?: boolean; sync: boolean }) {
   effects.push(["destination", options]); fail("destination");
   if (options.dest !== 2 && options.dest !== admittedPath) throw new Error("destination crossover");
   return {
    write(text: string) { effects.push(["write", text]); if (script.kind === "directory" && options.dest !== 2) throw new Error("EISDIR"); output.push({ channel: options.dest === 2 ? "fd2" : "file", text }); },
    flushSync() { effects.push(["flush"]); if (script.kind === "directory" && options.dest !== 2) throw new Error("EISDIR"); },
    end() { effects.push(["end"]); },
   };
  },
  stderr(text: string) { effects.push(["stderr", text]); output.push({ channel: "stderr", text }); return true; },
  logger(destination: { write(text: string): void } | undefined, enabled: boolean) {
   const logger = {
    child() { return logger; },
    info(text: string) { if (enabled) destination!.write(text); },
    debug(text: string) { if (enabled) destination!.write(text); },
    warn(text: string) { if (enabled) destination!.write(text); },
    error(text: string) { if (enabled) destination!.write(text); },
    flush() { effects.push(["logger-flush"]); },
   };
   return logger;
  },
 };
 return boundary;
}
export type Boundary = ReturnType<typeof createBoundary>;

// Independent operation-input model with real descriptor ownership and effects.
// Control faults alter executed operations, not the observed/expected comparator.
export function modelAdmission(input: Input, b: Boundary, fault: Fault = "none") {
 const enabled = input.enabled || fault === "allocate-disabled";
 let destination: ReturnType<Boundary["destination"]> | undefined;
 if (enabled) {
  try {
   const path = fault === "wrong-path" ? input.path + "-foreign" : input.path;
   const parent = path.slice(0, path.lastIndexOf("/"));
   b.mkdir(parent, { recursive: true });
   const fd = b.open(path, "a");
   let directory = false;
   try {
    if (fault === "early-close") b.close(fd);
    const stats = fault === "omit-stat" ? { isDirectory: () => false } : b.stat(fault === "wrong-fd" ? fd + 1 : fd);
    directory = stats!.isDirectory() && fault !== "ignore-directory";
   } finally {
    if (fault !== "omit-close" && fault !== "early-close") b.close(fd);
    if (fault === "double-close") b.close(fd);
   }
   if (directory) return fallback();
   destination = b.destination({ dest: path, mkdir: true, sync: fault !== "async-stream" });
  } catch { return fallback(); }
 }
 const logger = b.logger(destination, enabled);
 if (fault !== "omit-write") logger.info(fault === "wrong-message" ? "wrong message" : input.message);
 if (enabled) {
  if (fault !== "omit-flush") destination!.flushSync();
  if (fault !== "omit-end") destination!.end();
 }
 function fallback() {
  const rpc = fault === "wrong-fallback" ? input.runtime !== "rpc-runtime" : input.runtime === "rpc-runtime";
  const sink = rpc ? b.destination({ dest: 2, sync: false }) : { write: (text: string) => { b.stderr(text); } };
  const logger = b.logger(sink, enabled);
  if (fault !== "omit-write") logger.info(fault === "wrong-message" ? "wrong message" : input.message);
  logger.flush();
 }
}


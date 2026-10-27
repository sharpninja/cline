import { describe, expect, it, vi } from "vitest";
import { createBoundary, modelAdmission, type Boundary, type Fault, type Input, type Script } from "./destination-admission.test-support";

const binding = vi.hoisted(() => ({ boundary: undefined as Boundary | undefined }));
vi.mock("node:fs", async () => {
 const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
 return { ...actual,
  mkdirSync: (...args: Parameters<Boundary["mkdir"]>) => binding.boundary!.mkdir(...args),
  openSync: (...args: Parameters<Boundary["open"]>) => binding.boundary!.open(...args),
  fstatSync: (...args: Parameters<Boundary["stat"]>) => binding.boundary!.stat(...args),
  closeSync: (...args: Parameters<Boundary["close"]>) => binding.boundary!.close(...args),
  existsSync: () => false,
 };
});
vi.mock("@cline/shared", () => ({ registerDisposable() {} }));
// All contract operations provide an explicit synthetic destination. A default-path read is forbidden here.
vi.mock("./log-path", () => ({ resolveCliLogPath() { throw new Error("unexpected default-path resolution"); } }));
vi.mock("pino", () => {
 const factory = Object.assign((options: { enabled?: boolean }, destination: Parameters<Boundary["logger"]>[0]) =>
  binding.boundary!.logger(destination, options.enabled !== false), {
   destination: (options: Parameters<Boundary["destination"]>[0]) => binding.boundary!.destination(options),
   stdTimeFunctions: { isoTime() { return ""; } },
  });
 return { default: factory };
});
const mode = process.env.CLINE_LOG_ADMISSION_PROVIDER === "Production" ? "Production" : "Mock";
const input: Input = { path: "/synthetic-c-owned/logs/session.log", message: "original fallback message", enabled: true };
type Expected = { effects: unknown[][]; descriptors: Boundary["descriptors"]; output: Boundary["output"]; error?: string };
type Scenario = { id: string; input: Input; script: Script; expected: Expected };
const mkdir = ["mkdir", "/synthetic-c-owned/logs", { recursive: true }];
const open = ["open", input.path, "a"];
const stat = ["fstat", 71];
const close = ["close", 71];
const destination = ["destination", { dest: input.path, mkdir: true, sync: true }];
const fallback = [["stderr", input.message], ["logger-flush"]];
const closed = [{ id: 71, closed: true, closeCount: 1 }];
const openDescriptor = [{ id: 71, closed: false, closeCount: 1 }];
const stderr = [{ channel: "stderr", text: input.message }];
const scenarios: Scenario[] = [
 { id: "opened-directory-rejected-and-closed-before-fallback", input, script: { kind: "directory" }, expected: { effects: [mkdir, open, stat, ["fstat-result", "directory"], close, ...fallback], descriptors: closed, output: stderr } },
 { id: "regular-file-keeps-sync-write-flush-close", input, script: { kind: "file" }, expected: { effects: [mkdir, open, stat, ["fstat-result", "file"], close, destination, ["write", input.message], ["flush"], ["end"]], descriptors: closed, output: [{ channel: "file", text: input.message }] } },
 { id: "mkdir-error-fallback-no-descriptor", input, script: { kind: "file", fail: "mkdir" }, expected: { effects: [mkdir, ...fallback], descriptors: [], output: stderr } },
 { id: "open-error-fallback-no-descriptor", input, script: { kind: "file", fail: "open" }, expected: { effects: [mkdir, open, ...fallback], descriptors: [], output: stderr } },
 { id: "descriptor-stat-error-closes-before-fallback", input, script: { kind: "file", fail: "stat" }, expected: { effects: [mkdir, open, stat, ["fstat-error", "scripted:stat"], close, ...fallback], descriptors: closed, output: stderr } },
 { id: "close-error-never-allocates-stream", input, script: { kind: "file", fail: "close" }, expected: { effects: [mkdir, open, stat, ["fstat-result", "file"], close, ...fallback], descriptors: openDescriptor, output: stderr } },
 { id: "stream-construction-error-keeps-fallback", input, script: { kind: "file", fail: "destination" }, expected: { effects: [mkdir, open, stat, ["fstat-result", "file"], close, destination, ...fallback], descriptors: closed, output: stderr } },
 { id: "disabled-logger-allocates-no-destination", input: { ...input, enabled: false }, script: { kind: "file" }, expected: { effects: [], descriptors: [], output: [] } },
 { id: "rpc-directory-keeps-existing-fd2-fallback", input: { ...input, runtime: "rpc-runtime" }, script: { kind: "directory" }, expected: { effects: [mkdir, open, stat, ["fstat-result", "directory"], close, ["destination", { dest: 2, sync: false }], ["write", input.message], ["logger-flush"]], descriptors: closed, output: [{ channel: "fd2", text: input.message }] } },
 { id: "rpc-file-keeps-sync-file-destination", input: { ...input, runtime: "rpc-runtime" }, script: { kind: "file" }, expected: { effects: [mkdir, open, stat, ["fstat-result", "file"], close, destination, ["write", input.message], ["flush"], ["end"]], descriptors: closed, output: [{ channel: "file", text: input.message }] } },
];
async function run(operation: Input, script: Script, provider: string, fault: Fault = "none") {
 const boundary = createBoundary(structuredClone(script));
 binding.boundary = boundary;
 let error: string | undefined;
 const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((text: string) => boundary.stderr(text)) as never);
 try {
  if (provider === "Mock") modelAdmission(structuredClone(operation), boundary, fault);
  else {
   const production = await import("./adapter");
   const adapter = production.createCliLoggerAdapter({ runtime: operation.runtime ?? "cli", runtimeConfig: {
    enabled: operation.enabled, level: "info", destination: operation.path, name: "synthetic-c-admission", bindings: {},
   } });
   try { adapter.core.log(operation.message); } finally { production.shutdownCliLoggerAdapters(); }
  }
 } catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
 finally { stderrSpy.mockRestore(); }
 return { effects: boundary.effects, descriptors: boundary.descriptors, output: boundary.output, error };
}
function assertObserved(actual: Awaited<ReturnType<typeof run>>, expected: Expected) {
 expect(actual.error).toBe(expected.error);
 expect(actual.effects).toEqual(expected.effects);
 expect(actual.descriptors).toEqual(expected.descriptors);
 expect(actual.output).toEqual(expected.output);
}
async function assertScenario(scenario: Scenario, script = scenario.script, fault: Fault = "none", provider = mode) {
 const observed = await run(scenario.input, script, provider, fault);
 console.info("C_LOG_ADMISSION " + JSON.stringify({ scenario: scenario.id, provider, script, fault, observed }));
 assertObserved(observed, scenario.expected);
}
async function rejects(scenario: Scenario, script: Script, fault: Fault = "none") {
 let rejection: unknown;
 try { await assertScenario(scenario, script, fault, "Mock"); } catch (caught) { rejection = caught; }
 expect(rejection).toBeInstanceOf(Error);
 expect((rejection as Error).name).toBe("AssertionError");
}
describe(`original logger destination admission (${mode})`, () => {
 for (const scenario of scenarios) it(scenario.id, async () => { await assertScenario(scenario); });
 for (const fault of ["omit-stat", "ignore-directory", "omit-close", "double-close", "early-close", "wrong-fd", "wrong-path", "wrong-message", "omit-write"] as const) {
  it(`directory rejects executed fault ${fault}`, async () => { await rejects(scenarios[0], scenarios[0].script, fault); });
 }
 for (const fault of ["omit-stat", "omit-close", "double-close", "early-close", "wrong-fd", "wrong-path", "async-stream", "wrong-message", "omit-write", "omit-flush", "omit-end"] as const) {
  it(`file rejects executed fault ${fault}`, async () => { await rejects(scenarios[1], scenarios[1].script, fault); });
 }
 for (const fault of ["wrong-fallback", "omit-close", "ignore-directory", "early-close", "wrong-message", "omit-write"] as const) {
  it(`RPC directory rejects executed fault ${fault}`, async () => { await rejects(scenarios[8], scenarios[8].script, fault); });
 }
 it("CLI rejects descriptor2 fallback", async () => { await rejects(scenarios[0], scenarios[0].script, "wrong-fallback"); });
 it("RPC rejects directory changing to file", async () => { await rejects(scenarios[8], { kind: "file" }); });
 it("disabled rejects actual allocation", async () => { await rejects(scenarios[7], scenarios[7].script, "allocate-disabled"); });
 for (const script of [
  { kind: "file" as const }, { kind: "directory" as const, fail: "open" as const },
  { kind: "directory" as const, fail: "stat" as const }, { kind: "directory" as const, missingStat: true },
 ]) it(`directory rejects changed/missing dependency response ${JSON.stringify(script)}`, async () => { await rejects(scenarios[0], script); });
 for (const script of [
  { kind: "directory" as const }, { kind: "file" as const, fail: "open" as const },
  { kind: "file" as const, fail: "stat" as const }, { kind: "file" as const, missingStat: true },
  { kind: "file" as const, fail: "close" as const }, { kind: "file" as const, fail: "destination" as const },
 ]) it(`file rejects changed/missing dependency response ${JSON.stringify(script)}`, async () => { await rejects(scenarios[1], script); });
});


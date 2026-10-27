import { describe, expect, it, vi } from "vitest";
import { createInteractions, modelStop, type Fault, type Interactions, type Row, type Script, type StopInput } from "./resource-lifetime.test-support";

// Only the dependency classes change when the SAME runner binds production.
const binding = vi.hoisted(() => ({ dependencies: undefined as Interactions | undefined }));
vi.mock("@cline/core", async () => {
 const actual = await vi.importActual<typeof import("@cline/core")>("@cline/core");
 return { ...actual,
  get SqliteSessionStore() { return binding.dependencies!.Store; },
  get CoreSessionService() { return binding.dependencies!.Service; },
  get HubSessionClient() { return binding.dependencies!.Rpc; },
 };
});
const mode = process.env.CLINE_RESOURCE_PROVIDER === "Production" ? "Production" : "Mock";
const rows: Row[] = [
 { sessionId: "a", metadata: { owner: "canary-c" } },
 { sessionId: "child", parentSessionId: "parent", metadata: { owner: "canary-c" } },
 { sessionId: "foreign", metadata: { owner: "foreign" } },
 { sessionId: "b", metadata: { owner: "canary-c" } },
];
type Expected = { value?: number; error?: string; effects: string[]; stores: { id: string; closed: boolean; closeCount: number }[] };
type Scenario = { id: string; script: Script; expected: Expected };
const rpcFailure = ["rpc:new:synthetic-c:0", "rpc:list:5000", "rpc:list:throw", "rpc:close"];
const localPrefix = [...rpcFailure, "store:new:owned-1", "service:new:owned-1", "local:list:5000:owned-1"];
const matches = ["match:local:canary-c", "match:local:foreign", "match:local:canary-c"];
const closed = [{ id: "owned-1", closed: true, closeCount: 1 }];
const scenarios: Scenario[] = [
 { id: "fallback-success", script: { localRows: rows }, expected: { value: 2, effects: [...localPrefix, "local:list:ok", ...matches, "local:delete:start:a", "local:delete:start:b", "local:delete:ok:a", "local:delete:ok:b", "store:close:owned-1"], stores: closed } },
 { id: "fallback-list-throws", script: { localRows: rows, listError: "list failed" }, expected: { error: "list failed", effects: [...localPrefix, "local:list:throw", "store:close:owned-1"], stores: closed } },
 { id: "fallback-one-delete-fails", script: { localRows: rows, deleteErrors: ["a"] }, expected: { value: 2, effects: [...localPrefix, "local:list:ok", ...matches, "local:delete:start:a", "local:delete:start:b", "local:delete:throw:a", "local:delete:ok:b", "store:close:owned-1"], stores: closed } },
 { id: "fallback-all-deletes-fail", script: { localRows: rows, deleteErrors: ["a", "b"] }, expected: { value: 2, effects: [...localPrefix, "local:list:ok", ...matches, "local:delete:start:a", "local:delete:start:b", "local:delete:throw:a", "local:delete:throw:b", "store:close:owned-1"], stores: closed } },
 { id: "fallback-empty", script: { localRows: [] }, expected: { value: 0, effects: [...localPrefix, "local:list:ok", "store:close:owned-1"], stores: closed } },
 { id: "rpc-success-no-store", script: { localRows: rows, rpcRows: rows }, expected: { value: 2, effects: ["rpc:new:synthetic-c:0", "rpc:list:5000", "rpc:list:ok", "match:rpc:canary-c", "match:rpc:foreign", "match:rpc:canary-c", "rpc:stop:a", "rpc:stop:b", "rpc:delete:a:true", "rpc:delete:b:true", "rpc:close"], stores: [] } },
];
async function run(script: Script, fault: Fault = "none", provider = mode) {
 const dependencies = createInteractions(structuredClone(script));
 binding.dependencies = dependencies;
 const input: StopInput = {
  rpcAddress: "synthetic-c:0",
  localMatcher(metadata) { dependencies.effects.push(`match:local:${metadata?.owner}`); return metadata?.owner === "canary-c"; },
  rpcMatcher(metadata) { dependencies.effects.push(`match:rpc:${metadata?.owner}`); return metadata?.owner === "canary-c"; },
 };
 let value: number | undefined;
 let error: string | undefined;
 try {
  value = provider === "Mock" ? await modelStop(input, dependencies, fault) : await (await import("./session-runtime")).stopConnectorSessions(input);
 } catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
 return { value, error, effects: dependencies.effects, stores: dependencies.stores };
}
function assertObserved(observed: Awaited<ReturnType<typeof run>>, expected: Expected) {
 expect(observed.value).toBe(expected.value);
 expect(observed.error).toBe(expected.error);
 expect(observed.effects).toEqual(expected.effects);
 expect(observed.stores).toEqual(expected.stores);
}
async function assertScenario(scenario: Scenario, script = scenario.script, fault: Fault = "none", provider = mode) {
 const observed = await run(script, fault, provider);
 console.info(`C_RESOURCE_INTERACTIONS ${JSON.stringify({ scenario: scenario.id, provider, fault, script, observed })}`);
 assertObserved(observed, scenario.expected);
}
async function requireRejection(scenario: Scenario, script: Script, fault: Fault = "none") {
 let rejection: unknown;
 try { await assertScenario(scenario, script, fault, "Mock"); } catch (caught) { rejection = caught; }
 expect(rejection).toBeInstanceOf(Error);
 expect((rejection as Error).name).toBe("AssertionError");
}
describe(`owned fallback store lifetime (${mode})`, () => {
 for (const scenario of scenarios) {
  it(`${scenario.id}: same results and ordered interactions`, async () => { await assertScenario(scenario); });
  const faults: Fault[] = scenario.script.rpcRows ? ["wrong-count", "allocate-on-rpc"] : scenario.script.listError ? ["omit-close", "double-close", "early-close"] : ["omit-close", "double-close", "early-close", "wrong-count"];
  for (const fault of faults) it(`${scenario.id}: rejects ${fault} through same assertions`, async () => { await requireRejection(scenario, scenario.script, fault); });
 }
 for (const fault of ["reverse-delete", "omit-delete", "close-before-settled"] as const) it(`rejects ${fault} effects through same assertions`, async () => { await requireRejection(scenarios[0], scenarios[0].script, fault); });
 for (const mutation of [
  { localRows: [] },
  { localRows: [...rows].reverse() },
  { localRows: rows, missingDeleteResponse: "a" },
  { localRows: rows, wrongDeleteResponse: "b" },
  { localRows: rows, deleteErrors: ["b"] },
  { localRows: rows, listError: "unexpected list failure" },
 ]) it(`rejects wrong/missing/reordered scripted dependency response ${JSON.stringify(mutation)}`, async () => { await requireRejection(scenarios[0], mutation); });
 it("rejects wrong RPC row identity through same assertions", async () => { await requireRejection(scenarios[5], { localRows: rows, rpcRows: [{ sessionId: "other", metadata: { owner: "canary-c" } }] }); });
});


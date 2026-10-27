// SPDX-License-Identifier: Apache-2.0
/** Test-only observation vocabulary, not a production policy/event/lifecycle API.
 * Native adapters must capture existing calls/effects; expected records never enter an adapter.
 * AC-QB-013/016/017/018/053/071/072. Native and live acceptance remain separate.
 */
import assert from "node:assert/strict";
export type Root = { workspace: string; agent: string; session: string; request: string };
export type FileState = { path: string; kind: "file" | "directory" | "link"; bytes: string; owner: string; permissions: string; target: string | null };
export type Identity = { root: Root; distinctId: string; home: string; documents: string; state: string; discovery: string; port: number; temp: string };
export type Store = { provider: string; credential: string | null; generation: number };
export type Step =
  | { op: "initialize" | "import" | "construct" | "rawRead" | "lastUsed" | "getter"; context: string }
  | { op: "request"; context: string; reply: "ok" | "invalid" | "timeout" | "cancel" | "assertion-failure" }
  | { op: "resolve"; context: string; call: string }
  | { op: "refresh"; context: string; credential: string }
  | { op: "signOut"; context: string }
  | { op: "finish"; context: string };
export type Input = {
  identities: Record<string, Identity>;
  stores: Record<string, Store>;
  external: FileState[];
  steps: Step[];
};
export type Event = { root: Root; operation: string; data: unknown };
export type Observation = {
  journal: Event[];
  external: FileState[];
  privateStores: Record<string, Store>;
  results: { root: Root; call: string; credential: string | null }[];
  terminals: { root: Root; outcome: string }[];
  exercisedFaults: string[];
};
export interface Adapter { execute(input: Input, fault?: Fault): Promise<Observation> }
export type Expected = Omit<Observation, "exercisedFaults">;
export type Scenario = { id: string; requirements: string[]; nativeSteps: string[]; input: Input; expected: Expected; controls: Fault[] };
export const faults = [
  "import-before-initialize", "omit-initialize", "mutable-namespace", "wrong-distinct-id", "wrong-discovery", "wrong-port",
  "upstream-raw-read", "redirected-documents-read", "omit-raw-read", "duplicate-raw-read", "reorder-constructor",
  "getter-hides-raw-read", "omit-migration", "omit-custom-load", "omit-configured-register", "omit-permission-hardening", "wrong-recovery-root", "wrong-provider-path", "cloud-fallback", "wrong-provider", "omit-request", "duplicate-request",
  "wrong-request-root", "write-upstream", "create-absent-upstream", "change-permissions", "change-owner",
  "change-link", "extra-file", "wrong-terminal", "omit-cleanup", "cleanup-upstream", "omit-refresh",
  "duplicate-refresh", "stale-refresh", "restore-after-signout", "rebind-late-callback", "omit-waiter",
] as const;
export type Fault = typeof faults[number];
/** SAME full journal, filesystem inventory and results for independent and future native adapters. */
export function assertConstructorIsolation(actual: Observation, expected: Expected): void {
  for (const key of ["journal", "external", "privateStores", "results", "terminals"] as const)
    assert.deepStrictEqual(actual[key], expected[key], "CONSTRUCTOR_ISOLATION:" + key);
}
export async function runConstructorScenario(adapter: Adapter, scenario: Scenario, fault?: Fault): Promise<Observation> {
  const before = structuredClone(scenario.input);
  // Deliberately pass only input. No expected, case id, or requirement-derived summary reaches the model.
  const actual = await adapter.execute(scenario.input, fault);
  assert.deepStrictEqual(scenario.input, before, "CONSTRUCTOR_ISOLATION:caller input mutation");
  return actual;
}




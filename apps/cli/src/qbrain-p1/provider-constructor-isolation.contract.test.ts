// Bounded constructor isolation contract. No provider, host lifecycle or SDK imports.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

export interface ConstructorFixture {
  parent: string; derivative: string; original: string; peer: string; providerPath: string;
}
export interface StorageAccess { operation: string; path: string }
export interface ConstructorObservation {
  filePath: string; accesses: StorageAccess[]; providers: unknown;
  acknowledgedUnchanged: boolean;
}
export type ConstructorFactory = (input: ConstructorFixture) => Promise<ConstructorObservation>;
export function createConstructorFixture(): ConstructorFixture {
  const parent = fs.mkdtempSync(join(tmpdir(), "qb-c15-constructor-"));
  const derivative = join(parent, "derivative", "data");
  const original = join(parent, "original", ".cline");
  const peer = join(parent, "peer", ".cline-qb");
  for (const root of [derivative, original, peer]) fs.mkdirSync(join(root, "settings"), { recursive: true });
  for (const root of [original, peer]) {
    fs.writeFileSync(join(root, "settings", "providers.json"), '{"syntheticCanary":"original-provider-bytes"}');
    fs.writeFileSync(join(root, "secrets.json"), '{"syntheticCanary":"no-real-credential"}');
    fs.writeFileSync(join(root, "globalState.json"), '{"syntheticCanary":"original-state"}');
  }
  // Empty derivative legacy files exercise both actual migration reads without activating a provider.
  fs.writeFileSync(join(derivative, "globalState.json"), "{}");
  fs.writeFileSync(join(derivative, "secrets.json"), "{}");
  return { parent, derivative, original, peer, providerPath: join(derivative, "settings", "providers.json") };
}
function inventory(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  function walk(path: string): void {
    for (const entry of fs.readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) walk(child);
      else result[relative(root, child)] = fs.readFileSync(child).toString("base64");
    }
  }
  walk(root);
  return result;
}
export async function assertConstructorIsolation(factory: ConstructorFactory): Promise<ConstructorObservation> {
  const input = createConstructorFixture();
  const before = inventory(input.parent);
  const observed = await factory(Object.freeze({ ...input }));
  assert.equal(observed.filePath, input.providerPath, "Namespace wins over all synthetic legacy overrides");
  assert.deepEqual(observed.providers, {}, "No original provider or credentials were imported");
  assert.equal(observed.acknowledgedUnchanged, true);
  assert.deepEqual(inventory(input.parent), before, "Observed complete before/after bytes, not unchanged acknowledgment");
  assert.ok(observed.accesses.length > 0, "Actual storage effects are captured");
  for (const access of observed.accesses) {
    const path = resolve(access.path);
    assert.ok(path === resolve(input.derivative) || path.startsWith(resolve(input.derivative) + sep),
      "No original, peer or outside storage access: " + access.operation + " " + path);
    assert.ok(["existsSync", "readFileSync", "statSync", "chmodSync"].includes(access.operation),
      "No constructor content mutation: " + access.operation);
  }
  for (const name of ["globalState.json", "secrets.json"]) {
    assert.ok(observed.accesses.some((access) => access.operation === "readFileSync" && access.path === join(input.derivative, name)),
      "Capture migration read of derivative " + name);
  }
  assert.ok(observed.accesses.some((access) => access.path === join(input.derivative, "settings", "models.json")),
    "Capture custom-provider registry probe");
  console.log(JSON.stringify({ evidenceKind: "bounded constructor filesystem isolation", requirements: ["AC-QB-016", "AC-QB-017", "AC-QB-064"], input, observed, before, after: inventory(input.parent), actualGovernedHost: false }));
  return observed;
}
type Fault = "none" | "original-access" | "peer-access" | "outside-access" | "wrong-path" | "omit-effects" | "omit-migration" | "omit-custom" | "changed-canary" | "deleted-canary" | "forbidden-write";
export const independentConstructor = (fault: Fault = "none"): ConstructorFactory => async (input) => {
  // Independent input-only filesystem actor, never receives expected results or an assertion object.
  const accesses: StorageAccess[] = [];
  function read(path: string): void { accesses.push({ operation: "readFileSync", path }); fs.readFileSync(path); }
  read(join(input.derivative, "globalState.json"));
  read(join(input.derivative, "secrets.json"));
  accesses.push({ operation: "existsSync", path: join(input.derivative, "settings", "models.json") });
  fs.existsSync(join(input.derivative, "settings", "models.json"));
  if (fault === "original-access") read(join(input.original, "secrets.json"));
  if (fault === "peer-access") read(join(input.peer, "settings", "providers.json"));
  if (fault === "outside-access") accesses.push({ operation: "existsSync", path: join(input.parent, "outside.json") });
  if (fault === "omit-effects") accesses.length = 0;
  if (fault === "omit-migration") accesses.splice(0, 1);
  if (fault === "omit-custom") accesses.pop();
  if (fault === "changed-canary") fs.writeFileSync(join(input.original, "secrets.json"), "changed");
  if (fault === "deleted-canary") fs.unlinkSync(join(input.peer, "globalState.json"));
  if (fault === "forbidden-write") {
    const path = join(input.derivative, "unexpected.json");
    accesses.push({ operation: "writeFileSync", path }); fs.writeFileSync(path, "unexpected");
  }
  return { filePath: fault === "wrong-path" ? join(input.original, "settings", "providers.json") : input.providerPath,
    providers: {}, accesses, acknowledgedUnchanged: true };
};
export async function proveConstructorAssertions(): Promise<void> {
  await assertConstructorIsolation(independentConstructor());
  let rejected = 0;
  for (const fault of ["original-access", "peer-access", "outside-access", "wrong-path", "omit-effects", "omit-migration", "omit-custom", "changed-canary", "deleted-canary", "forbidden-write"] as const) {
    await assert.rejects(() => assertConstructorIsolation(independentConstructor(fault)), assert.AssertionError);
    rejected++;
    console.log(JSON.stringify({ control: fault, rejectedBySameAssertions: true }));
  }
  console.log(JSON.stringify({ correct: 1, rejected, failed: 0, skipped: 0, actualGovernedHost: false }));
}
if (import.meta.main) await proveConstructorAssertions();
else if (process.env.VITEST) {
  const { it } = await import("vitest");
  it("constructor isolation assertions reject actual wrong accesses and filesystem effects", proveConstructorAssertions);
}

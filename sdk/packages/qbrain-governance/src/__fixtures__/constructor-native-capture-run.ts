// SPDX-License-Identifier: Apache-2.0
/** First-party SDK native capture fixture. Run ONLY under an exact O lease.
 * All original inputs are retained, including operations still unbound. This
 * records evidence; it does not register passing unit tests or accept a contract.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { constructorScenarios } from "./p1-constructor-isolation-cases";

const [ownedParent, node, bundleHash] = process.argv.slice(2);
assert.ok(ownedParent && node && bundleHash, "CAPTURE: explicit owned parent/Node/artifact pin required");
const workspace = fileURLToPath(new URL("../../../../../", import.meta.url));
const permittedParent = resolve(workspace, ".mcpServer");
const parent = resolve(ownedParent);
const contained = (base: string, path: string) => {
  const value = relative(base, path);
  return value === "" || (!isAbsolute(value) && value !== ".." && !value.startsWith(".." + sep));
};
assert.ok(contained(permittedParent, parent), "CAPTURE: task parent must be inside excluded own checkout cache");
assert.ok(fs.statSync(parent).isDirectory(), "CAPTURE: checked PowerShell launcher must create parent");
const run = fs.mkdtempSync(join(parent, "native-constructor-"));
const childEntry = fileURLToPath(new URL("./constructor-native-capture.mjs", import.meta.url));
const results: unknown[] = [];
for (const [caseIndex, scenario] of constructorScenarios.entries()) {
  const inputBefore = structuredClone(scenario.input);
  const caseRoot = join(run, String(caseIndex).padStart(2, "0"));
  fs.mkdirSync(caseRoot);
  const aliases = Object.entries(scenario.input.identities).flatMap(([key, identity]) => [
    { logical: identity.home, native: join(caseRoot, key, "home") },
    { logical: identity.state, native: join(caseRoot, key, "private") },
    { logical: identity.documents, native: join(caseRoot, key, "redirected-documents") },
    { logical: identity.temp, native: join(caseRoot, key, "tmp") },
    { logical: identity.root.workspace, native: join(caseRoot, key, "workspace") },
  ]).concat([{ logical: "/external/immutable-target", native: join(caseRoot, "canary-target") }])
    .sort((a, b) => b.logical.length - a.logical.length);
  const project = (logical: string) => {
    const alias = aliases.find((a) => logical === a.logical || logical.startsWith(a.logical + "/"));
    assert.ok(alias, "CAPTURE: unmapped logical fixture path: " + logical);
    const result = resolve(alias.native, "." + logical.slice(alias.logical.length));
    assert.ok(contained(caseRoot, result), "CAPTURE: native alias escaped case root");
    return result;
  };
  for (const alias of aliases) fs.mkdirSync(alias.native, { recursive: true });
  for (const external of scenario.input.external) {
    const path = project(external.path);
    fs.mkdirSync(dirname(path), { recursive: true });
    if (external.kind === "directory") fs.mkdirSync(path, { recursive: true });
    else if (external.kind === "link") fs.symlinkSync(project(external.target!), path,
      process.platform === "win32" ? "junction" : "dir");
    else fs.writeFileSync(path, external.bytes, { mode: Number.parseInt(external.permissions, 8) });
  }
  function inventory() {
    // Raw native inventory, not fixture owner/mode labels substituted as facts.
    return scenario.input.external.map((external) => {
      const path = project(external.path), stat = fs.lstatSync(path);
      return { logical: external.path, path, uid: stat.uid, gid: stat.gid, mode: stat.mode,
        kind: stat.isSymbolicLink() ? "link" : stat.isDirectory() ? "directory" : "file",
        target: stat.isSymbolicLink() ? fs.readlinkSync(path) : null,
        bytes: stat.isFile() ? fs.readFileSync(path, "utf8") : null };
    });
  }
  const baseline = inventory();
  for (const [key, identity] of Object.entries(scenario.input.identities)) {
    const state = scenario.input.stores[key];
    const settings = { provider: state.provider, modelId: "fixture-direct",
      ...(state.credential ? { apiKey: state.credential } : {}) };
    const providerPath = join(project(identity.state), "data", "settings", "providers.json");
    fs.mkdirSync(dirname(providerPath), { recursive: true });
    fs.writeFileSync(providerPath, JSON.stringify({ version: 1, modes: {},
      lastUsedProvider: state.provider, providers: {
        [state.provider]: { settings, updatedAt: "2026-10-01T00:00:00.000Z", tokenSource: "manual" },
      },
    }), { mode: 0o600 });
  }
  const inputPath = join(caseRoot, "input.json");
  fs.writeFileSync(inputPath, JSON.stringify(scenario.input));
  const children: unknown[] = [];
  for (const [key, identity] of Object.entries(scenario.input.identities)) {
    const stdout = join(caseRoot, key + ".stdout.jsonl"), stderr = join(caseRoot, key + ".stderr.log");
    const outputFd = fs.openSync(stdout, "wx"), errorFd = fs.openSync(stderr, "wx");
    const env: NodeJS.ProcessEnv = {};
    for (const name of ["SystemRoot", "WINDIR", "ComSpec", "PATH", "PATHEXT"]) {
      if (process.env[name]) env[name] = process.env[name];
    }
    const home = project(identity.home), temp = project(identity.temp), state = project(identity.state);
    Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
      TEMP: temp, TMP: temp, CLINE_QB_DIR: state, CLINE_QB_HUB_HOST: "127.0.0.1",
      CLINE_QB_HUB_PORT: String(identity.port), CLINE_QB_HUB_DISCOVERY_PATH: join(state, "hub.json"),
      NO_COLOR: "1", CI: "true",
    });
    let child: ReturnType<typeof spawnSync>;
    try {
      child = spawnSync(node, [childEntry, inputPath, key, caseRoot, bundleHash], {
        cwd: project(identity.root.workspace), env, stdio: ["ignore", outputFd, errorFd], windowsHide: true,
      });
    } finally { fs.closeSync(outputFd); fs.closeSync(errorFd); }
    children.push({ context: key, pid: child.pid, status: child.status,
      signal: child.signal, error: child.error?.message ?? null, stdout, stderr });
  }
  const final = inventory();
  assert.deepEqual(scenario.input, inputBefore, "CONSTRUCTOR_ISOLATION:caller input mutation");
  results.push({ id: scenario.id, originalInput: scenario.input, aliases, baseline, final, children,
    unchangedListedCanaries: JSON.stringify(baseline) === JSON.stringify(final),
    // Complete recursive external inventories/Windows ACLs/full SAME oracle
    // comparison and provider/OAuth operations remain gates, not implied passes.
    sameContractAsserted: false, accepted: false });
}
const report = { run, originalInputs: constructorScenarios.length, captures: results,
  testsRegistered: 0, nativeCasesAccepted: 0, fullSDKAccepted: false, productComplete: false };
fs.writeFileSync(join(run, "capture.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ capturePath: join(run, "capture.json"), originalInputs: report.originalInputs,
  nativeCasesAccepted: 0, fullSDKAccepted: false }));

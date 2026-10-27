// SPDX-License-Identifier: Apache-2.0
/** Native CAPTURE probe, not a substitute passing implementation of the frozen
 * constructor contract. Receives the original input only. Unbound operations
 * remain explicit holds; neither expectations nor scenario IDs are accepted.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import cp from "node:child_process";
import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import dgram from "node:dgram";
import { syncBuiltinESMExports } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { observeCompiledConstructor } from "./compiled-constructor-observer.mjs";
import { captureNativeMember } from "./capture-native-member.mjs";

const [inputFile, context, ownedRoot, expectedBundleHash] = process.argv.slice(2);
assert.ok(inputFile && context && ownedRoot && expectedBundleHash, "CAPTURE: four explicit arguments required");
const root = resolve(ownedRoot);
const inside = (parent, path) => {
  const part = relative(parent, path);
  return part === "" || (!part.startsWith(".." + sep) && part !== ".." && !isAbsolute(part));
};
assert.ok(inside(root, resolve(inputFile)), "CAPTURE: input must be task owned");
const input = JSON.parse(fs.readFileSync(inputFile, "utf8"));
assert.deepEqual(Object.keys(input).sort(), ["external", "identities", "steps", "stores"], "CAPTURE: input-only boundary");
const identity = input.identities[context];
assert.ok(identity && input.stores[context], "CAPTURE: unknown original context");
const before = structuredClone(input);
const native = {
  home: resolve(root, context, "home"), state: resolve(root, context, "private"),
  documents: resolve(root, context, "redirected-documents"), temp: resolve(root, context, "tmp"),
};
for (const path of Object.values(native)) {
  assert.ok(inside(root, path), "CAPTURE: escaped native projection");
  assert.ok(fs.statSync(path).isDirectory(), "CAPTURE: launcher must provision directories before child");
}
assert.equal(resolve(homedir()), native.home, "CAPTURE: inherited operator HOME refused");
assert.equal(resolve(tmpdir()), native.temp, "CAPTURE: inherited operator TEMP refused");
assert.equal(resolve(process.env.CLINE_QB_DIR ?? ""), native.state, "CAPTURE: wrong private namespace");
for (const name of Object.keys(process.env)) {
  if (/^(ANTHROPIC|OPENAI|OPENROUTER|CLINE|GEMINI|GOOGLE|AZURE|AWS).*(_KEY|_TOKEN|_SECRET|PASSWORD)$/i.test(name))
    throw new Error("CAPTURE: inherited credential environment refused: " + name);
}
const bundleUrl = new URL("../../../core/dist/index.js", import.meta.url);
const bundlePath = fileURLToPath(bundleUrl);
const { createHash } = await import("node:crypto");
const bundle = fs.readFileSync(bundlePath, "utf8");
assert.equal(createHash("sha256").update(bundle).digest("hex").toUpperCase(), expectedBundleHash,
  "CAPTURE: compiled artifact drift");
const raw = [], effects = [], bindingHolds = [];
let ordinal = 0, currentOperation = "pre-import", core, manager, observer, instance, filtered;
const emit = (operation, data) => raw.push({ order: ++ordinal, root: structuredClone(identity.root), operation, data });
function pathValue(value) {
  if (typeof value === "number" || value === undefined) return null;
  return resolve(value instanceof URL ? fileURLToPath(value) : String(value));
}
const originals = {};
function captureFs(name, mutation) {
  const original = fs[name];
  if (typeof original !== "function") return;
  originals[name] = original;
  fs[name] = function (...args) {
    const path = pathValue(args[0]);
    const entry = { api: name, path, during: currentOperation, arguments: args.slice(1).map((value) =>
      typeof value === "string" || typeof value === "number" ? value : value == null ? value : typeof value) };
    emit("fs.call", entry);
    // Block ALL writes outside owned space. Application reads of code/cache are
    // retained, while a synthetic upstream canary access is never hidden.
    if (mutation && path && !inside(root, path)) throw new Error("CAPTURE: write outside owned root");
    try {
      const result = Reflect.apply(original, this, args);
      effects.push({ ...entry, ok: true,
        result: name === "existsSync" ? result : name === "readFileSync" && typeof result === "string" ? result : undefined });
      return result;
    } catch (error) {
      effects.push({ ...entry, ok: false, code: error?.code, message: String(error?.message ?? error) });
      throw error;
    }
  };
  captureNativeMember(original, fs[name], (event) => {
    emit("fs.native." + event.phase, { api: name + ".native", during: currentOperation, ...event });
    effects.push({ api: name + ".native", during: currentOperation, ...event });
  });
}
for (const name of ["existsSync", "readFileSync", "readdirSync", "lstatSync", "statSync", "realpathSync", "readlinkSync"])
  captureFs(name, false);
for (const name of ["mkdirSync", "writeFileSync", "appendFileSync", "chmodSync", "unlinkSync", "rmSync"])
  captureFs(name, true);
originals.renameSync = fs.renameSync;
fs.renameSync = function (from, to, ...rest) {
  assert.ok(inside(root, pathValue(from)) && inside(root, pathValue(to)), "CAPTURE: rename outside owned root");
  emit("fs.call", { api: "renameSync", from: pathValue(from), to: pathValue(to), during: currentOperation });
  return Reflect.apply(originals.renameSync, this, [from, to, ...rest]);
};
// Observe asynchronous filesystem calls too; original methods still perform
// the work. Unknown writes cannot escape to the operator or another fixture.
for (const name of ["readFile", "readdir", "lstat", "stat", "realpath", "readlink",
  "mkdir", "writeFile", "appendFile", "chmod", "unlink", "rm", "rename", "copyFile"]) {
  const original = fs.promises[name];
  const mutation = ["mkdir", "writeFile", "appendFile", "chmod", "unlink", "rm", "rename", "copyFile"].includes(name);
  fs.promises[name] = async function (...args) {
    const path = pathValue(args[0]);
    const second = name === "rename" || name === "copyFile" ? pathValue(args[1]) : null;
    emit("fs.promise.call", { api: name, path, second, during: currentOperation });
    if (mutation && ((path && !inside(root, path)) || (second && !inside(root, second))))
      throw new Error("CAPTURE: asynchronous write outside owned root");
    return Reflect.apply(original, this, args);
  };
}
const originalExecFileSync = cp.execFileSync;
cp.execFileSync = function (file, args, ...rest) {
  // Existing specific Known Documents dependency, not a new host API. This is a
  // declared SCRIPTED dependency result, never native Windows known-folder proof.
  if (Array.isArray(args) && args.some((arg) => typeof arg === "string" &&
      arg.includes('[Environment]::GetFolderPath("MyDocuments")'))) {
    assert.equal(resolve(String(file)).toLowerCase(),
      resolve(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe").toLowerCase(),
      "CAPTURE: changed Known Documents executable");
    emit("known-documents.scripted-dependency", { executable: String(file), args, result: native.documents });
    return native.documents + "\r\n";
  }
  emit("process.blocked", { executable: String(file), args });
  throw new Error("CAPTURE: unexpected child process");
};
const blockNetwork = (kind) => (...args) => {
  emit("network.blocked", { kind, target: String(args[0]?.url ?? args[0]?.hostname ?? args[0]) });
  throw new Error("CAPTURE: constructor attempted network");
};
net.connect = net.createConnection = blockNetwork("net");
tls.connect = blockNetwork("tls");
http.request = http.get = blockNetwork("http");
https.request = https.get = blockNetwork("https");
globalThis.fetch = blockNetwork("fetch");
globalThis.WebSocket = class { constructor(url) { blockNetwork("websocket")(url); } };
dgram.createSocket = blockNetwork("dgram");
for (const name of ["lookup", "resolve", "resolve4", "resolve6", "reverse"]) {
  dns[name] = blockNetwork("dns." + name);
  if (dns.promises[name]) dns.promises[name] = blockNetwork("dns.promises." + name);
}
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "fork"])
  cp[name] = blockNetwork("unexpected-process." + name);
syncBuiltinESMExports();

try {
  for (const step of input.steps) {
    if (step.context !== context) continue; // other identities are separate native children
    currentOperation = step.op;
    switch (step.op) {
      case "initialize": {
        const storage = await import("../../dist/host-storage.js");
        const namespace = storage.initializeQbrainStorage();
        emit("namespace.actual", {
          state: namespace.resolvePath("root", { homeDir: native.home }),
          descriptor: Object.getOwnPropertyDescriptor(globalThis, Symbol.for("@cline/qbrain-governance/storage-host/v1")),
        });
        break;
      }
      case "import":
        core = await import(bundleUrl.href);
        observer = observeCompiledConstructor(core, bundle, bundleUrl.href);
        emit("core.import.returned", { artifact: bundlePath });
        break;
      case "construct":
        assert.ok(core && observer, "CAPTURE: core import/observer must precede actual construction");
        instance = await core.ClineCore.create({
          backendMode: "local", distinctId: identity.distinctId, clientName: "qbrain-constructor-native-fixture",
          automation: false, fetch: globalThis.fetch,
        });
        // Private access is test-only to capture the actual already-constructed
        // manager. It does not inject a replacement manager after construction.
        manager = instance.host?.providerSettingsManager;
        assert.ok(manager instanceof core.ProviderSettingsManager, "CAPTURE: actual host manager not found");
        filtered = (await import("../../dist/cloud-policy.js")).withoutClineAccountSettings(manager);
        emit("core.create.returned", { distinctId: instance.distinctId, providerSettingsPath: manager.getFilePath() });
        break;
      case "rawRead":
        emit("provider.rawRead.returned", manager.read());
        break;
      case "lastUsed":
        emit("provider.lastUsed.returned", manager.getLastUsedProviderSettings() ?? null);
        break;
      case "getter":
        emit("provider.get.returned", filtered.getProviderSettings(input.stores[context].provider) ?? null);
        break;
      case "finish":
        await instance?.dispose();
        emit("core.dispose.returned", {});
        break;
      default:
        // NOT skipped/passed. The original operation stays an explicit unbound
        // SAME-contract assertion until the real provider/OAuth adapter exists.
        bindingHolds.push(structuredClone(step));
    }
  }
  observer?.assertHealthy();
  assert.deepEqual(input, before, "CONSTRUCTOR_ISOLATION:caller input mutation");
} catch (error) {
  bindingHolds.push({ operation: currentOperation, error: String(error?.stack ?? error) });
} finally {
  observer?.close();
  cp.execFileSync = originalExecFileSync;
}
console.log(JSON.stringify({
  root: identity.root, native, raw, effects,
  privateCalls: observer?.rows ?? [], captureFailures: observer?.failures ?? [],
  correspondence: observer?.correspondence ?? null, bindingHolds,
  fullContractAsserted: false, nativeConstructorAccepted: false,
  knownDocuments: "scripted existing dependency; native Windows known-folder remains open",
}, (_key, value) => value instanceof Error
  ? { error: value.name, message: value.message, stack: value.stack, own: Object.fromEntries(Object.entries(value)) }
  : value));


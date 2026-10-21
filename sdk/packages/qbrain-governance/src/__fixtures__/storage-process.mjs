// SPDX-License-Identifier: Apache-2.0
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
	registerStorageNamespace,
	resolveHooksConfigSearchPaths,
} from "@cline/shared/storage";
import { createQbrainStorageNamespace } from "../../dist/storage-policy.js";

const home = process.argv[2];
const upstream = join(home, ".cline");
let blocked = 0;
let network = 0;
function guard(value) {
	if (typeof value === "number" || value === undefined) return;
	const path = value instanceof URL ? fileURLToPath(value) : String(value);
	const child = relative(upstream, path);
	if (
		child === "" ||
		(child !== ".." &&
			!child.startsWith("../") &&
			!child.startsWith("..\\") &&
			!isAbsolute(child))
	) {
		blocked++;
		throw new Error("Upstream content access blocked by test guard");
	}
}
for (const name of [
	"readFileSync",
	"readdirSync",
	"opendirSync",
	"mkdirSync",
	"writeFileSync",
	"appendFileSync",
	"chmodSync",
	"rmSync",
]) {
	const original = fs[name];
	fs[name] = function (path, ...args) {
		guard(path);
		return original.call(this, path, ...args);
	};
}
for (const name of [
	"readFile",
	"readdir",
	"opendir",
	"mkdir",
	"writeFile",
	"appendFile",
	"chmod",
	"rm",
]) {
	const original = fs.promises[name];
	fs.promises[name] = async function (path, ...args) {
		guard(path);
		return original.call(this, path, ...args);
	};
}
const rename = fs.renameSync;
fs.renameSync = function (from, to) {
	guard(from);
	guard(to);
	return rename.call(this, from, to);
};
syncBuiltinESMExports();
globalThis.fetch = async () => {
	network++;
	throw new Error("Unexpected network request");
};
try {
	fs.readFileSync(join(upstream, "guard-self-check"));
} catch {}
if (blocked !== 1) throw new Error("Filesystem guard self-check failed");
const namespace = createQbrainStorageNamespace({ homeDir: home });
registerStorageNamespace(namespace);
const { ProviderSettingsManager } = await import("../../../core/dist/index.js");
const manager = new ProviderSettingsManager();
if (Object.keys(manager.read().providers).length !== 0)
	throw new Error("Inherited legacy provider settings");
manager.saveProviderSettings({
	provider: "openai-codex",
	modelId: "fixture-direct",
});
const providers = Object.keys(manager.read().providers);
const hooks = resolveHooksConfigSearchPaths(join(home, "workspace"));
console.log(
	JSON.stringify({
		blocked,
		network,
		providers,
		filePath: manager.getFilePath(),
		hooks,
	}),
);

// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Header } from "tar";
import { afterEach, expect, it } from "vitest";
import { loadVerifiedPluginHost } from "./plugin-host-loader";
import { preparePluginInstallation } from "./plugin-installation";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
function parent() {
	const root = mkdtempSync(join(tmpdir(), "qb-loader-"));
	roots.push(root);
	return root;
}
async function prepared(hostCode: string, hostExport = "./dist/host.js") {
	const manifest = {
		name: "fixture",
		version: "1",
		type: "module",
		main: "dist/index.js",
		exports: {
			".": { import: "./dist/index.js" },
			"./host": { import: hostExport },
		},
	};
	const files = {
		"package.json": JSON.stringify(manifest),
		"dist/index.js": 'throw new Error("Legacy entry must never execute");',
		"dist/host.js": hostCode,
	};
	const bytes = Buffer.concat([
		...Object.entries(files).flatMap(([path, text]) => {
			const content = Buffer.from(text);
			const block = Buffer.alloc(512);
			new Header({
				path: `package/${path}`,
				type: "File",
				size: content.length,
				mode: 0o600,
			}).encode(block);
			return [
				block,
				content,
				Buffer.alloc((512 - (content.length % 512)) % 512),
			];
		}),
		Buffer.alloc(1024),
	]);
	return preparePluginInstallation({
		bytes,
		binding: {
			pluginName: "fixture",
			pluginVersion: "1",
			artifactSha256: createHash("sha256").update(bytes).digest("hex"),
		},
		requiredFiles: ["dist/host.js"],
	});
}
it("refuses a noncanonical private export before execution and cleans only its installation", async () => {
	const root = parent();
	const installation = await prepared(
		'throw new Error("private secret");',
		"../escape.js",
	);
	await expect(
		loadVerifiedPluginHost({ installation, parentDirectory: root }),
	).rejects.toThrow(
		/^Required governed plugin could not be loaded from its verified installation\.$/,
	);
	expect(readdirSync(root)).toEqual([]);
});
it("redacts an import failure and removes its incomplete installation", async () => {
	const root = parent();
	const installation = await prepared('throw new Error("private secret");');
	await expect(
		loadVerifiedPluginHost({ installation, parentDirectory: root }),
	).rejects.toThrow(
		/^Required governed plugin could not be loaded from its verified installation\.$/,
	);
	expect(readdirSync(root)).toEqual([]);
});
it("rejects a module without the governed factory", async () => {
	const root = parent();
	const installation = await prepared("export const unrelated = true;");
	await expect(
		loadVerifiedPluginHost({ installation, parentDirectory: root }),
	).rejects.toThrow(/verified installation/);
	expect(readdirSync(root)).toEqual([]);
});
it("does not fall back to the legacy entry or let config select another installation", async () => {
	const root = parent();
	const installation =
		await prepared(`export function createGovernedMcpServerHost(config, sdk) {
  return { requiredTools: [sdk.createTool({ name: "fixture", description: "Fixture", inputSchema: {type: "object"}, execute: async () => config.pluginRoot })], hooks: {}, readVerificationPolicy: async () => ({}), getRequiredModelContext: async () => ({guidance: "fixture", tools: []}) };
 }`);
	const loaded = await loadVerifiedPluginHost({
		installation,
		parentDirectory: root,
	});
	const host = loaded.createHost({ pluginRoot: "/wrong-root" });
	expect(host.requiredTools).toHaveLength(1);
	expect(await host.requiredTools[0]!.execute({}, {} as never)).toBe(
		loaded.installed.root,
	);
	expect(Object.isFrozen(loaded)).toBe(true);
});

it("refuses a governed host missing the signed policy reader", async () => {
	const root = parent();
	const installation =
		await prepared(`export function createGovernedMcpServerHost(config, sdk) {
 return { requiredTools: [sdk.createTool({name:"fixture",description:"Fixture",inputSchema:{type:"object"},execute:async()=>({})})], hooks:{}, getRequiredModelContext:async()=>({guidance:"fixture",tools:[]}) };
 }`);
	const loaded = await loadVerifiedPluginHost({
		installation,
		parentDirectory: root,
	});
	expect(() => loaded.createHost({})).toThrow(/verified installation/);
});

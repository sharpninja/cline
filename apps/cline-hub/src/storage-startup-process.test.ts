// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const guard = `
const fs=require('node:fs'),path=require('node:path');
const originalWrite=fs.writeFileSync;
const roots=JSON.parse(process.env.QB_STORAGE_FORBIDDEN);
let hits=0,network=0;
function check(value){if(typeof value!=='string')return;for(const root of roots){const r=path.relative(root,path.resolve(value));if(r===''||(r!=='..'&&!r.startsWith('..'+path.sep)&&!path.isAbsolute(r))){hits++;throw new Error('Fixture blocked upstream content access');}}}
for(const name of ['readFileSync','readdirSync','mkdirSync','writeFileSync','appendFileSync','chmodSync']){const fn=fs[name];fs[name]=function(p,...args){check(p);return fn.call(this,p,...args);};}
for(const name of ['readFile','readdir','mkdir','writeFile','appendFile','chmod']){const fn=fs.promises[name];fs.promises[name]=async function(p,...args){check(p);return fn.call(this,p,...args);};}
const rename=fs.renameSync;fs.renameSync=function(a,b){check(a);check(b);return rename.call(this,a,b);};
const block=()=>{network++;throw new Error('Fixture blocked network');};globalThis.fetch=block;
for(const [m,names] of Object.entries({'node:http':['request','get'],'node:https':['request','get'],'node:net':['connect','createConnection'],'node:tls':['connect']})){for(const name of names)require(m)[name]=block;}
require('node:module').syncBuiltinESMExports();
try{fs.readFileSync(path.join(roots[0],'self-check'));}catch{}if(hits!==1)throw new Error('Guard self-check failed');hits=0;
process.on('exit',()=>originalWrite(process.env.QB_STORAGE_GUARD_LOG,JSON.stringify({hits,network})));
`;
describe("TEST-QB-002/053: real standalone dashboard module startup", () => {
	it.each([
		"fresh",
		"legacy",
		"private-overrides",
	])("isolates provider storage and configuration with %s state", (mode) => {
		const home = mkdtempSync(join(tmpdir(), "qb-hub-startup-"));
		try {
			const upstream = join(home, ".cline");
			const old = join(upstream, "data", "settings", "providers.json");
			const legacy = JSON.stringify({
				version: 1,
				providers: {
					cline: {
						settings: { provider: "cline", apiKey: "fixture-only" },
						updatedAt: "2026-01-01T00:00:00Z",
						tokenSource: "manual",
					},
				},
				modes: {},
				lastUsedProvider: "cline",
			});
			if (mode === "legacy") {
				mkdirSync(dirname(old), { recursive: true });
				writeFileSync(old, legacy);
			}
			const env: NodeJS.ProcessEnv =
				mode === "private-overrides"
					? {
							CLINE_QB_DIR: join(home, "private-root"),
							CLINE_QB_HUB_DASHBOARD_PORT: "9099",
							CLINE_QB_HUB_PORT: "30001",
							CLINE_QB_HUB_WEBVIEW_DIST_DIR: join(home, "private-webview"),
							CLINE_QB_HUB_DISCOVERY_PATH: join(home, "private-discovery.json"),
						}
					: {};
			const child = run(home, env);
			expect(child.status, child.stderr).toBe(0);
			expect(child.guard).toEqual({ hits: 0, network: 0 });
			const result = JSON.parse(child.stdout.trim().split("\n").at(-1)!);
			const root =
				mode === "private-overrides"
					? join(home, "private-root")
					: join(home, ".cline-qb");
			expect(result.path).toBe(
				join(root, "data", "settings", "providers.json"),
			);
			expect(result.providers).toEqual(["openai-codex"]);
			expect(result.port).toBe(mode === "private-overrides" ? 9099 : 8797);
			expect(result.endpoint).toEqual({
				host: "127.0.0.1",
				port: mode === "private-overrides" ? 30001 : 25473,
				pathname: "/hub",
			});
			expect(result.discovery).toBe(
				mode === "private-overrides"
					? join(home, "private-discovery.json")
					: join(root, "data", "locks", "hub", "production.json"),
			);
			expect(result.webview).not.toBe(join(home, "upstream-webview"));
			if (mode === "private-overrides")
				expect(result.webview).toBe(join(home, "private-webview"));
			expect(result.launch.launcher).toMatch(/[/\\]/);
			expect(result.launch.argsPrefix).toContain(
				resolve("../cli/src/index.ts"),
			);
			if (mode === "legacy") expect(readFileSync(old, "utf8")).toBe(legacy);
			else expect(existsSync(upstream)).toBe(false);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	}, 45000);
});
function run(home: string, extra: NodeJS.ProcessEnv) {
	const preload = join(home, "guard.cjs"),
		log = join(home, "guard.json");
	writeFileSync(preload, guard);
	const code = `await import(${JSON.stringify(resolve("src/server.ts"))}); const deps=await import(${JSON.stringify(resolve("src/server/deps.ts"))}); const core=await import('@cline/core/hub'); const shared=await import('@cline/shared'); const discovery=core.resolveProductionHubOwnerContext().discoveryPath; if(Object.keys(deps.providerSettingsManager.read().providers).length) throw new Error('Legacy providers inherited'); deps.providerSettingsManager.saveProviderSettings({provider:'openai-codex',modelId:'fixture-direct'}); console.log(JSON.stringify({path:deps.providerSettingsManager.getFilePath(),providers:Object.keys(deps.providerSettingsManager.read().providers),port:deps.port,webview:deps.webviewDistDir,endpoint:core.resolveHubEndpointOptions(),discovery,launch:shared.getHubDaemonLaunchSpec()}));`;
	const env: NodeJS.ProcessEnv = {
		PATH: process.env.PATH,
		HOME: home,
		USERPROFILE: home,
		SystemRoot: process.env.SystemRoot,
		CLINE_BUILD_ENV: "production",
		CLINE_DIR: join(home, ".cline"),
		CLINE_DATA_DIR: join(home, ".cline", "data"),
		CLINE_PROVIDER_SETTINGS_PATH: join(
			home,
			".cline",
			"data",
			"settings",
			"providers.json",
		),
		CLINE_HUB_HOST: "upstream",
		CLINE_HUB_PORT: "25463",
		CLINE_HUB_PATHNAME: "/upstream",
		CLINE_HUB_DISCOVERY_PATH: join(home, ".cline", "discovery.json"),
		CLINE_HUB_DASHBOARD_PORT: "8787",
		CLINE_HUB_WEBVIEW_DIST_DIR: join(home, "upstream-webview"),
		QB_STORAGE_FORBIDDEN: JSON.stringify([
			join(home, ".cline"),
			join(home, "Documents", "Cline"),
			join(home, "Cline"),
		]),
		QB_STORAGE_GUARD_LOG: log,
		...extra,
	};
	const child = spawnSync("bun", ["--preload", preload, "--eval", code], {
		cwd: process.cwd(),
		env,
		encoding: "utf8",
		timeout: 30000,
	});
	expect(child.error).toBeUndefined();
	return {
		...child,
		guard: existsSync(log) ? JSON.parse(readFileSync(log, "utf8")) : null,
	};
}

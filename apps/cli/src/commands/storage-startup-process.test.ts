// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
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
process.on('exit',()=>originalWrite(process.env.QB_STORAGE_GUARD_LOG,JSON.stringify({hits,network,configRoot:process.env.CLINE_QB_DIR ?? null})));
`;

describe("TEST-QB-002/053: real CLI storage startup", () => {
	it.each([
		"fresh",
		"legacy",
		"config",
		"data",
		"provider-path",
	])("writes direct provider settings to isolated %s state", (mode) => {
		const home = mkdtempSync(join(tmpdir(), "qb-cli-storage-"));
		try {
			const upstream = join(home, ".cline");
			const legacyPath = join(upstream, "data", "settings", "providers.json");
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
				mkdirSync(dirname(legacyPath), { recursive: true });
				writeFileSync(legacyPath, legacy);
			}
			const config = join(home, "configured");
			const data = join(home, "isolated-data");
			const args = [
				"auth",
				"--provider",
				"openai-native",
				"--apikey",
				"fixture-only",
				"--modelid",
				"fixture-direct",
			];
			if (mode === "config") args.push("--config", config);
			if (mode === "data") args.push("--data-dir", data);
			const expected =
				mode === "provider-path"
					? join(home, "private-provider.json")
					: join(
							mode === "data"
								? data
								: join(
										mode === "config" ? config : join(home, ".cline-qb"),
										"data",
									),
							"settings",
							"providers.json",
						);
			const result = run(
				home,
				args,
				mode === "provider-path"
					? { CLINE_QB_PROVIDER_SETTINGS_PATH: expected }
					: {},
			);
			expect(result.status, result.stderr).toBe(0);
			expect(result.guard).toMatchObject({ hits: 0, network: 0 });
			if (mode === "config") expect(result.guard.configRoot).toBe(config);
			expect(
				JSON.parse(readFileSync(expected, "utf8")).providers["openai-native"]
					.settings.model,
			).toBe("fixture-direct");
			if (mode === "legacy")
				expect(readFileSync(legacyPath, "utf8")).toBe(legacy);
			else expect(existsSync(upstream)).toBe(false);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	}, 45000);
	it.each([
		"--config",
		"--data-dir",
	])("refuses %s aliasing upstream storage before content access", (option) => {
		const home = mkdtempSync(join(tmpdir(), "qb-cli-storage-deny-"));
		try {
			const upstream = join(home, ".cline");
			mkdirSync(upstream);
			const alias = join(home, "alias");
			symlinkSync(upstream, alias, "junction");
			const result = run(home, [
				"auth",
				"--provider",
				"openai-native",
				"--apikey",
				"fixture-only",
				"--modelid",
				"fixture-direct",
				option,
				alias,
			]);
			expect(result.status).toBe(1);
			expect(result.stdout + result.stderr).toContain("upstream Cline");
			expect(result.guard).toMatchObject({ hits: 0, network: 0 });
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	}, 45000);
});
function run(home: string, args: string[], extra: NodeJS.ProcessEnv = {}) {
	const preload = join(home, "guard.cjs"),
		log = join(home, "guard.json");
	writeFileSync(preload, guard);
	const env: NodeJS.ProcessEnv = {
		PATH: process.env.PATH,
		HOME: home,
		USERPROFILE: home,
		SystemRoot: process.env.SystemRoot,
		CLINE_DIR: join(home, ".cline"),
		CLINE_DATA_DIR: join(home, ".cline", "data"),
		CLINE_PROVIDER_SETTINGS_PATH: join(
			home,
			".cline",
			"data",
			"settings",
			"providers.json",
		),
		CLINE_GLOBAL_SETTINGS_PATH: join(
			home,
			".cline",
			"data",
			"settings",
			"global-settings.json",
		),
		QB_STORAGE_FORBIDDEN: JSON.stringify([
			join(home, ".cline"),
			join(home, "Documents", "Cline"),
			join(home, "Cline"),
		]),
		QB_STORAGE_GUARD_LOG: log,
		...extra,
	};
	const child = spawnSync(
		"bun",
		["--preload", preload, resolve("src/index.ts"), ...args],
		{ cwd: process.cwd(), env, encoding: "utf8", timeout: 30000 },
	);
	expect(child.error).toBeUndefined();
	return {
		...child,
		guard: existsSync(log) ? JSON.parse(readFileSync(log, "utf8")) : null,
	};
}

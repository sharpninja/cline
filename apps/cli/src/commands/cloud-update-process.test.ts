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
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
const guard = `
const fs=require('node:fs');
const traceDirectory=process.env.QB_UPDATE_TRACE_DIRECTORY;
const trace=traceDirectory?(()=>{
 const fd=fs.openSync(require('node:path').join(traceDirectory,process.pid+'.jsonl'),'ax');
 process.once('exit',()=>fs.closeSync(fd));
 return require(${JSON.stringify(resolve('src/commands/updater-guard-trace.test-support.ts'))}).createUpdaterGuardTrace(entry=>fs.writeSync(fd,JSON.stringify(entry)+'\\n'));
})():undefined;
const block=(name)=>{
 const original=(...args)=>{fs.appendFileSync(process.env.QB_UPDATE_GUARD_LOG,name+'\\n');throw new Error('QB blocked '+name);};
 return trace?trace.wrap(name,original):original;
};
globalThis.fetch=block('fetch');
for(const [module,names] of Object.entries({'node:http':['request','get'],'node:https':['request','get'],'node:net':['connect','createConnection'],'node:tls':['connect'],'node:child_process':['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']})){
 const target=require(module);for(const name of names)target[name]=block(module+':'+name);
}
require('node:module').syncBuiltinESMExports();
`;
describe("TEST-QB-016/017: real CLI updater process isolation", () => {
	it.each([
		[false, "--update"],
		[true, "--update"],
		[false, "update"],
		[true, "update"],
	] as const)(
		"legacy=%s route=%s refuses without network or installers",
		(legacy, route) => {
			const root = mkdtempSync(join(tmpdir(), "qb-updater-process-"));
			roots.push(root);
			const data = join(root, "data");
			mkdirSync(data);
			const settings = join(data, "global-settings.json");
			writeFileSync(settings, JSON.stringify({ autoUpdateEnabled: legacy }));
			const wrapper = join(root, "node_modules", "cline", "bin", "cline");
			mkdirSync(join(root, "node_modules", "cline", "bin"), {
				recursive: true,
			});
			writeFileSync(wrapper, "");
			const preload = join(root, "guard.cjs"),
				log = join(root, "guard.log");
			writeFileSync(preload, guard);
			const env: NodeJS.ProcessEnv = {
				...process.env,
				CLINE_GLOBAL_SETTINGS_PATH: settings,
				CLINE_DATA_DIR: data,
				CLINE_DIR: data,
				CLINE_QB_DATA_DIR: data,
				CLINE_WRAPPER_PATH: wrapper,
				CLINE_NO_AUTO_UPDATE: "0",
				IS_DEV: "false",
				CLINE_VCR: "",
				QB_UPDATE_GUARD_LOG: log,
			};
			delete env.NODE_OPTIONS;
			const result = spawnSync(
				"bun",
				[
					"--preload",
					preload,
					resolve("src/index.ts"),
					"--config",
					data,
					route,
				],
				{ cwd: process.cwd(), env, encoding: "utf8", timeout: 30000 },
			);
			expect(result.error).toBeUndefined();
			expect(result.status).toBe(1);
			expect(existsSync(log) ? readFileSync(log, "utf8") : "").toBe("");
			expect(result.stdout + result.stderr).toContain(
				"matching reviewed cline-qb build",
			);
		},
		45000,
	);
});

it("process guard detects fetch, sockets and installer subprocesses", () => {
	const root = mkdtempSync(join(tmpdir(), "qb-update-guard-"));
	roots.push(root);
	const preload = join(root, "guard.cjs"),
		log = join(root, "guard.log");
	writeFileSync(preload, guard);
	const exercise = `for(const call of [()=>fetch('https://example.invalid'),()=>require('node:net').connect(1),()=>require('node:child_process').spawn('fixture-never-executed')]){try{call()}catch{}}`;
	const result = spawnSync("bun", ["--preload", preload, "-e", exercise], {
		encoding: "utf8",
		env: { ...process.env, QB_UPDATE_GUARD_LOG: log },
		timeout: 10000,
	});
	expect(result.error).toBeUndefined();
	expect(result.status).toBe(0);
	const captured = readFileSync(log, "utf8");
	expect(captured).toContain("fetch");
	expect(captured).toContain("node:net:connect");
	expect(captured).toContain("node:child_process:spawn");
});

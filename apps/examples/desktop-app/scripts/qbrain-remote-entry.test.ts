// SPDX-License-Identifier: Apache-2.0
import { beforeAll, afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	mkdtempSync,
	readFileSync,
	writeFileSync,
	mkdirSync,
	rmSync,
	readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = mkdtempSync(join(tmpdir(), "qb-remote-entry-"));
const app = fileURLToPath(new URL("..", import.meta.url));
const script = readFileSync(join(app, "scripts/build-sidecar-bin.ts"), "utf8");
const entry = resolve(
	app,
	script.match(/"([^"\n]*remote-helper-entry\.(?:js|ts))"/)![1]!,
);
const binary = join(
	root,
	process.platform === "win32" ? "helper.exe" : "helper",
);
beforeAll(() => {
	const result = spawnSync(
		process.execPath,
		[
			"build",
			entry,
			"--compile",
			"--no-compile-autoload-dotenv",
			"--no-compile-autoload-bunfig",
			"--outfile",
			binary,
		],
		{ cwd: app, encoding: "utf8", timeout: 60000 },
	);
	expect(result.status, result.stderr).toBe(0);
}, 120000);
afterAll(() => rmSync(root, { recursive: true, force: true }));
function run(upstream: boolean) {
	const home = mkdtempSync(join(root, "home-"));
	const old = join(home, ".cline");
	mkdirSync(old);
	writeFileSync(join(old, "sentinel"), "keep");
	const result = spawnSync(
		binary,
		[
			"--remote-hub-stop",
			"--discovery-path",
			join(home, upstream ? ".cline" : ".cline-qb", "hub.json"),
		],
		{
			cwd: home,
			encoding: "utf8",
			timeout: 10000,
			env: {
				PATH: process.env.PATH,
				HOME: home,
				USERPROFILE: home,
				TMPDIR: home,
				TEMP: home,
				TMP: home,
				SystemRoot: process.env.SystemRoot,
				CLINE_DATA_DIR: old,
			},
		},
	);
	expect(result.error).toBeUndefined();
	expect(readFileSync(join(old, "sentinel"), "utf8")).toBe("keep");
	expect(readdirSync(old)).toEqual(["sentinel"]);
	return result;
}
test("compiled shipped remote helper rejects upstream discovery before reading it", () => {
	const r = run(true);
	expect(r.status).not.toBe(0);
	expect(r.stderr).toMatch(/upstream Cline/);
});
test("compiled shipped remote helper can stop an absent private Hub without upstream writes", () => {
	const r = run(false);
	expect(r.status, r.stderr).toBe(0);
});
test("desktop helper build targets the governed host entrypoint", () => {
	expect(entry).toBe(join(app, "sidecar/remote-helper-entry.ts"));
});

test("compiled remote host registers private storage, identity and its own daemon launch", () => {
	const home = mkdtempSync(join(root, "probe-home-"));
	const probe = join(root, "probe.ts"),
		probeBinary = join(
			root,
			process.platform === "win32" ? "probe.exe" : "probe",
		);
	writeFileSync(
		probe,
		`import ${JSON.stringify(entry)};import {resolveClineDataDir} from ${JSON.stringify(fileURLToPath(import.meta.resolve("@cline/shared/storage")))};import {getHubNamespace,getHubDaemonLaunchSpec} from ${JSON.stringify(fileURLToPath(import.meta.resolve("@cline/shared")))};console.log("HOST="+JSON.stringify({data:resolveClineDataDir(),hub:getHubNamespace(),launch:getHubDaemonLaunchSpec()}));`,
	);
	const build = spawnSync(
		process.execPath,
		[
			"build",
			probe,
			"--compile",
			"--no-compile-autoload-dotenv",
			"--no-compile-autoload-bunfig",
			"--outfile",
			probeBinary,
		],
		{ cwd: app, encoding: "utf8", timeout: 60000 },
	);
	expect(build.status, build.stderr).toBe(0);
	const result = spawnSync(
		probeBinary,
		["--remote-hub-stop", "--discovery-path", join(home, ".cline-qb/hub.json")],
		{
			cwd: home,
			encoding: "utf8",
			timeout: 10000,
			env: {
				PATH: process.env.PATH,
				HOME: home,
				USERPROFILE: home,
				SystemRoot: process.env.SystemRoot,
				TMPDIR: home,
				TMP: home,
				TEMP: home,
				CLINE_DATA_DIR: join(home, ".cline"),
				CLINE_HUB_PORT: "25472",
			},
		},
	);
	expect(result.status, result.stderr).toBe(0);
	const line = result.stdout.split("\n").find((s) => s.startsWith("HOST="));
	expect(line).toBeDefined();
	const value = JSON.parse(line!.slice(5));
	expect(value.data).toBe(join(home, ".cline-qb/data"));
	expect(value.hub).toMatchObject({
		requirePeerIdentity: true,
		productionPort: 25473,
		portVariable: "CLINE_QB_HUB_PORT",
	});
	expect(value.launch).toEqual({ launcher: probeBinary, argsPrefix: [] });
}, 90000);

// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const temporary = mkdtempSync(join(tmpdir(), "qb-desktop-entry-"));
const actualEntry = fileURLToPath(
	new URL("../sidecar/index.ts", import.meta.url),
);
const binary = join(
	temporary,
	process.platform === "win32" ? "sidecar.exe" : "sidecar",
);
const probeBinary = join(
	temporary,
	process.platform === "win32" ? "probe.exe" : "probe",
);
const probeEntry = join(temporary, "probe.ts");
beforeAll(() => {
	// The probe imports the real desktop entrypoint into a compiled Bun graph.
	// Its extra output exposes the registered daemon launch, without starting it.
	writeFileSync(
		probeEntry,
		`import ${JSON.stringify(actualEntry)};import {getHubDaemonLaunchSpec} from ${JSON.stringify(fileURLToPath(import.meta.resolve("@cline/shared")))};console.log("LAUNCH="+JSON.stringify(getHubDaemonLaunchSpec()));`,
	);
	for (const [entry, output] of [
		[actualEntry, binary],
		[probeEntry, probeBinary],
	]) {
		const result = spawnSync(
			process.execPath,
			[
				"build",
				entry!,
				"--compile",
				"--no-compile-autoload-dotenv",
				"--no-compile-autoload-bunfig",
				"--outfile",
				output!,
			],
			{ cwd: temporary, encoding: "utf8", timeout: 60000 },
		);
		expect(result.status, result.stderr || String(result.error)).toBe(0);
	}
}, 120000);
afterAll(() => rmSync(temporary, { recursive: true, force: true }));
function run(mode: string, executable = binary) {
	const home = mkdtempSync(join(temporary, "home-"));
	const upstream = join(home, ".cline");
	mkdirSync(upstream);
	writeFileSync(join(upstream, "sentinel.txt"), "keep");
	const env: NodeJS.ProcessEnv = {
		PATH: process.env.PATH,
		HOME: home,
		USERPROFILE: home,
		SystemRoot: process.env.SystemRoot,
		WINDIR: process.env.WINDIR,
		TMPDIR: home,
		TMP: home,
		TEMP: home,
		XDG_CONFIG_HOME: join(home, ".config"),
		CLINE_DATA_DIR: upstream,
	};
	if (mode === "override")
		env.CLINE_QB_MCP_SETTINGS_PATH = join(upstream, "mcp.json");
	if (mode === "alias")
		symlinkSync(upstream, join(home, ".cline-qb"), "junction");
	const result = spawnSync(executable, ["--telemetry-selfcheck"], {
		cwd: home,
		env,
		encoding: "utf8",
		timeout: 20000,
	});
	expect(result.error).toBeUndefined();
	expect(readFileSync(join(upstream, "sentinel.txt"), "utf8")).toBe("keep");
	expect(existsSync(join(upstream, "mcp.json"))).toBe(false);
	expect(existsSync(join(upstream, "data"))).toBe(false);
	return result;
}
test("compiled desktop initializes private storage without creating upstream state", () => {
	const result = run("fresh");
	expect(result.status, result.stderr).toBe(0);
	expect(JSON.parse(result.stdout.trim())).toMatchObject({ enabled: false });
});
test.each([
	"override",
	"alias",
])("compiled desktop refuses unsafe %s before selfcheck", (mode) => {
	const result = run(mode);
	expect(result.status).not.toBe(0);
	expect(result.stderr).toMatch(/upstream Cline/);
});
test("compiled daemon self-launch uses only its own executable", () => {
	const result = run("fresh", probeBinary);
	expect(result.status, result.stderr).toBe(0);
	const line = result.stdout.split("\n").find((s) => s.startsWith("LAUNCH="));
	expect(JSON.parse(line!.slice(7))).toEqual({
		launcher: probeBinary,
		argsPrefix: [],
	});
});

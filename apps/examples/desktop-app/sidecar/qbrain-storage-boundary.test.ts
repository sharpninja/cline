// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const entry = fileURLToPath(new URL("./index.ts", import.meta.url));
const shared = import.meta.resolve("@cline/shared");
const storage = import.meta.resolve("@cline/shared/storage");
const moduleUrl = (name: string) => new URL(name, import.meta.url).href;
function put(path: string, text: string) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
}
function snapshot(path: string): Record<string, string> {
	if (!existsSync(path)) return {};
	return Object.fromEntries(
		readdirSync(path, { recursive: true, withFileTypes: true })
			.filter((e) => e.isFile())
			.map((e) => {
				const p = join(e.parentPath, e.name);
				return [p, readFileSync(p).toString("base64")];
			}),
	);
}
function probe(mode: string) {
	const home = mkdtempSync(join(tmpdir(), "qb-desktop-storage-"));
	const upstream = join(home, ".cline"),
		root = join(home, ".cline-qb"),
		data = join(root, "data");
	const roots = [
		upstream,
		join(home, "Documents", "Cline"),
		join(home, "Cline"),
	];
	const env: NodeJS.ProcessEnv = {
		PATH: process.env.PATH,
		SystemRoot: process.env.SystemRoot,
		WINDIR: process.env.WINDIR,
		TEMP: home,
		TMP: home,
		TMPDIR: home,
		HOME: home,
		USERPROFILE: home,
		XDG_CONFIG_HOME: join(home, ".config"),
		NODE_ENV: "test",
	};
	if (mode !== "fresh")
		for (const r of roots)
			put(join(r, "sentinel.txt"), "upstream data must survive unchanged");
	if (mode === "legacy-env") {
		Object.assign(env, {
			CLINE_DIR: upstream,
			CLINE_DATA_DIR: join(upstream, "data"),
			CLINE_SESSION_DATA_DIR: join(upstream, "sessions"),
			CLINE_MCP_SETTINGS_PATH: join(upstream, "mcp.json"),
			CLINE_TOOL_APPROVAL_DIR: join(upstream, "approvals"),
			CLINE_KANBAN_DATA_DIR: join(upstream, "kanban"),
			CLINE_LOG_PATH: join(upstream, "code.log"),
			CLINE_HOOKS_LOG_PATH: join(upstream, "hooks.jsonl"),
			CLINE_HUB_PORT: "25472",
		});
		put(
			env.CLINE_HOOKS_LOG_PATH!,
			JSON.stringify({ sessionId: "s1", hookName: "UPSTREAM_READ" }),
		);
	}
	let expectedData = data,
		expectedMcp = join(data, "settings", "cline_mcp_settings.json");
	if (mode === "private-overrides") {
		expectedData = join(home, "private-data");
		expectedMcp = join(home, "private-mcp", "settings.json");
		Object.assign(env, {
			CLINE_QB_DATA_DIR: expectedData,
			CLINE_QB_MCP_SETTINGS_PATH: expectedMcp,
		});
	}
	if (mode === "mcp-upstream")
		env.CLINE_QB_MCP_SETTINGS_PATH = join(upstream, "mcp.json");
	if (mode.endsWith("-alias")) {
		const key = mode.slice(0, -6);
		const aliases: Record<string, string> = {
			data,
			mcp: expectedMcp,
			sessions: join(data, "sessions"),
			approvals: join(data, "sessions", "tool-approvals"),
			kanban: join(data, "apps", "kanban"),
			log: join(data, "logs", "code.log"),
			hooks: join(data, "logs", "hooks.jsonl"),
		};
		const link = aliases[key]!;
		mkdirSync(dirname(link), { recursive: true });
		mkdirSync(upstream, { recursive: true });
		const file = ["mcp", "log", "hooks"].includes(key);
		const target = file ? join(upstream, `${key}.json`) : upstream;
		if (file)
			put(
				target,
				key === "mcp"
					? JSON.stringify({
							mcpServers: { sentinel: { command: "never-run" } },
						})
					: "unchanged",
			);
		symlinkSync(target, link, file ? "file" : "junction");
	}
	const before = roots.map(snapshot);
	const code = `
 process.argv=[process.execPath,${JSON.stringify(entry)},"--telemetry-selfcheck"];
 await import(${JSON.stringify(moduleUrl("./index.ts"))});
 const storage=await import(${JSON.stringify(storage)});
 const shared=await import(${JSON.stringify(shared)});
 const paths=await import(${JSON.stringify(moduleUrl("./paths.ts"))});
 const mcp=await import(${JSON.stringify(moduleUrl("./mcp.ts"))});
 const hooks=await import(${JSON.stringify(moduleUrl("./session-data/artifacts.ts"))});
 const logging=await import(${JSON.stringify(moduleUrl("./logging.ts"))});
 const value={data:storage.resolveClineDataDir(),sessions:paths.sharedSessionDataDir(),approval:paths.toolApprovalDir(),kanban:paths.sessionLogPath("s1"),mcp:mcp.ensureMcpSettingsFile(),hooks:await hooks.readSessionHooks("s1"),hub:shared.getHubNamespace(),launch:shared.getHubDaemonLaunchSpec()};
 const logger=logging.createDesktopLoggerAdapter();logger.core.log("private-desktop-log");value.log=logger.runtimeConfig.destination;logger.dispose();
 console.log("STORAGE_RESULT="+JSON.stringify(value));
 `;
	try {
		const result = spawnSync(
			"bun",
			["--no-autoload-dotenv", "--no-autoload-bunfig", "--eval", code],
			{ cwd: dirname(entry), env, encoding: "utf8", timeout: 20000 },
		);
		expect(result.error).toBeUndefined();
		expect(roots.map(snapshot), "upstream contents changed").toEqual(before);
		expect(roots.map(existsSync)).toEqual(
			mode === "fresh" ? [false, false, false] : [true, true, true],
		);
		if (mode === "mcp-upstream" || mode.endsWith("-alias")) {
			expect(result.status, result.stdout + result.stderr).not.toBe(0);
			expect(result.stderr).toMatch(/upstream Cline/);
			return;
		}
		expect(result.status, result.stderr).toBe(0);
		const line = result.stdout
			.split("\n")
			.find((s) => s.startsWith("STORAGE_RESULT="));
		expect(line, result.stdout).toBeDefined();
		const value = JSON.parse(line!.slice("STORAGE_RESULT=".length));
		expect(value.data).toBe(expectedData);
		expect(value.sessions).toBe(join(expectedData, "sessions"));
		expect(value.approval).toBe(
			join(expectedData, "sessions", "tool-approvals"),
		);
		expect(value.kanban).toBe(
			join(expectedData, "apps", "kanban", "sessions", "s1.jsonl"),
		);
		expect(value.mcp).toBe(expectedMcp);
		expect(JSON.parse(readFileSync(expectedMcp, "utf8"))).toEqual({
			mcpServers: {},
		});
		expect(value.hooks).toEqual([]);
		expect(value.log).toBe(join(expectedData, "logs", "code.log"));
		expect(readFileSync(value.log, "utf8")).toContain("private-desktop-log");
		expect(value.hub).toMatchObject({
			requirePeerIdentity: true,
			portVariable: "CLINE_QB_HUB_PORT",
			productionPort: 25473,
		});
		expect(value.launch.argsPrefix).toContain(entry);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}
describe("AC053 desktop entrypoint storage isolation", () => {
	it.each([
		"fresh",
		"seeded",
		"legacy-env",
		"private-overrides",
		"mcp-upstream",
		"data-alias",
		"mcp-alias",
		"sessions-alias",
		"approvals-alias",
		"kanban-alias",
		"log-alias",
		"hooks-alias",
	])("isolates %s without touching upstream state", probe);
});

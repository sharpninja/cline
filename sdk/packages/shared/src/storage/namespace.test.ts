// SPDX-License-Identifier: Apache-2.0
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { registerStorageNamespace, type StoragePathKind } from "./namespace";
import * as paths from "./paths";

const kinds: [StoragePathKind, () => string][] = [
	["root", paths.resolveClineDir],
	["data", paths.resolveClineDataDir],
	["sessions", paths.resolveSessionDataDir],
	["teams", paths.resolveTeamDataDir],
	["connectors", paths.resolveConnectorDataDir],
	["connectorSettings", paths.resolveConnectorSettingsPath],
	["database", paths.resolveDbDataDir],
	["connectorsDatabase", paths.resolveConnectorsDbPath],
	["cronDatabase", paths.resolveCronDbPath],
	["tasksDatabase", paths.resolveTasksDbPath],
	["providerSettings", paths.resolveProviderSettingsPath],
	["globalSettings", paths.resolveGlobalSettingsPath],
	["mcpSettings", paths.resolveMcpSettingsPath],
	["documents", paths.resolveDocumentsClineDirectoryPath],
];
let deniedPath: string | undefined;
const namespace = {
	validatePath: (path: string) => {
		if (path === deniedPath) throw new Error("Forbidden child path");
		return path;
	},
	resolvePath: (kind: StoragePathKind, context: { rootOverride?: string }) => {
		if (context.rootOverride === "forbidden")
			throw new Error("Forbidden host root");
		return join("/host-owned", kind);
	},
	globalRulesPaths: () => ["/host-owned/rules"],
};
registerStorageNamespace(namespace);

describe("host storage namespace", () => {
	it.each([
		["agents", paths.resolveAgentConfigSearchPaths, join(".cline", "agents")],
		["hooks", paths.resolveHooksConfigSearchPaths, join(".cline", "hooks")],
		["skills", paths.resolveSkillsConfigSearchPaths, join(".cline", "skills")],
		["rules", paths.resolveRulesConfigSearchPaths, join(".cline", "rules")],
		[
			"workspace rules",
			paths.resolveWorkspaceRulesConfigPaths,
			join(".cline", "rules"),
		],
		[
			"workflows",
			paths.resolveWorkflowsConfigSearchPaths,
			join(".cline", "workflows"),
		],
		[
			"plugins",
			paths.resolvePluginConfigSearchPaths,
			join(".cline", "plugins"),
		],
	] as const)("refuses excluded workspace %s paths before discovery", (_name, discover, suffix) => {
		deniedPath = join("/workspace", suffix);
		try {
			expect(() => discover("/workspace")).toThrow("Forbidden child path");
		} finally {
			deniedPath = undefined;
		}
	});
	it("preserves allowed workspace rule and workflow discovery", () => {
		expect(paths.resolveRulesConfigSearchPaths("/workspace")).toContain(
			join("/workspace", ".clinerules"),
		);
		expect(paths.resolveWorkflowsConfigSearchPaths("/workspace")).toContain(
			join("/workspace", ".clinerules", "workflows"),
		);
		expect(paths.resolveSkillsConfigSearchPaths("/workspace")).toContain(
			join("/workspace", ".agents", "skills"),
		);
	});
	it.each(
		kinds,
	)("routes %s through the registered host policy", (kind, resolve) => {
		expect(resolve()).toBe(join("/host-owned", kind));
	});
	it("routes global contribution discovery without legacy user roots", () => {
		expect(paths.resolveGlobalRulesConfigPaths()).toEqual([
			"/host-owned/rules",
		]);
		expect(paths.resolveHooksConfigSearchPaths("/workspace")).toContain(
			join("/host-owned", "documents", "Hooks"),
		);
		expect(paths.resolveRulesConfigSearchPaths("/workspace")).toContain(
			join("/workspace", ".cline", "rules"),
		);
	});
	it("validates explicit root changes before mutating resolver state", () => {
		expect(() => paths.setClineDir("forbidden")).toThrow("Forbidden host root");
		expect(paths.resolveClineDir()).toBe(join("/host-owned", "root"));
		expect(() => paths.setClineDirIfUnset("forbidden")).toThrow(
			"Forbidden host root",
		);
	});
	it("allows repeat registration but refuses replacement", () => {
		expect(() => registerStorageNamespace(namespace)).not.toThrow();
		expect(() =>
			registerStorageNamespace({ ...namespace, resolvePath: () => "/other" }),
		).toThrow("already registered");
	});
	it("validates derived contribution directories before a consumer can scan them", () => {
		const attempts: [string, () => unknown][] = [
			[
				join("/host-owned", "root", "schedules"),
				paths.resolveAgentSchedulesDir,
			],
			[join("/host-owned", "root", "tasks"), paths.resolveGlobalTaskSpecsDir],
			[join("/host-owned", "root", "cron"), paths.resolveGlobalCronSpecsDir],
			[join("/host-owned", "root", "agents"), paths.resolveAgentsConfigDirPath],
			[
				join("/host-owned", "documents", "Hooks"),
				paths.resolveHooksConfigSearchPaths,
			],
			[
				join("/host-owned", "root", "skills"),
				paths.resolveSkillsConfigSearchPaths,
			],
			[
				join("/host-owned", "documents", "Workflows"),
				paths.resolveWorkflowsConfigSearchPaths,
			],
			[
				join("/host-owned", "root", "plugins"),
				paths.resolvePluginConfigSearchPaths,
			],
		];
		try {
			for (const [path, operation] of attempts) {
				deniedPath = path;
				expect(operation).toThrow("Forbidden child path");
			}
		} finally {
			deniedPath = undefined;
		}
	});
});

import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildMarketplaceMcpInput,
	fetchMarketplaceCatalog,
	installMarketplaceEntry,
	installMarketplaceEntryForDesktopCommand,
	listMarketplaceInstalledEntries,
	uninstallLocalPrimitive,
	uninstallMarketplaceEntry,
	uninstallMarketplaceEntryForDesktopCommand,
} from "./marketplace";

describe("marketplace installer", () => {
	const originalWrapperPath = process.env.CLINE_WRAPPER_PATH;
	const originalClineDir = process.env.CLINE_DIR;
	const originalHome = process.env.HOME;
	const originalMcpSettingsPath = process.env.CLINE_MCP_SETTINGS_PATH;

	afterEach(() => {
		if (originalWrapperPath === undefined) {
			delete process.env.CLINE_WRAPPER_PATH;
		} else {
			process.env.CLINE_WRAPPER_PATH = originalWrapperPath;
		}
		if (originalClineDir === undefined) {
			delete process.env.CLINE_DIR;
		} else {
			process.env.CLINE_DIR = originalClineDir;
		}
		if (originalHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHome;
		}
		if (originalMcpSettingsPath === undefined) {
			delete process.env.CLINE_MCP_SETTINGS_PATH;
		} else {
			process.env.CLINE_MCP_SETTINGS_PATH = originalMcpSettingsPath;
		}
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	function createInstalledOfficialPlugin(
		clineDir: string,
		slug: string,
	): string {
		const sourceKey = `official:https://github.com/cline/plugins.git#plugins/${slug}`;
		const hash = createHash("sha256")
			.update(sourceKey)
			.digest("hex")
			.slice(0, 12);
		const installPath = join(
			clineDir,
			"plugins",
			"_installed",
			"official",
			`${slug}-${hash}`,
		);
		mkdirSync(join(installPath, "package"), { recursive: true });
		writeFileSync(
			join(installPath, "package.json"),
			JSON.stringify({ name: slug }, null, 2),
			"utf8",
		);
		writeFileSync(
			join(installPath, "package", "index.ts"),
			`export default { name: "${slug}", manifest: { capabilities: ["tools"] } };`,
			"utf8",
		);
		return installPath;
	}

	it("maps remote MCP catalog args to MCP settings shape", () => {
		expect(
			buildMarketplaceMcpInput([
				"context7",
				"--transport",
				"http",
				"https://mcp.context7.com/mcp",
				"--header",
				"Authorization: Bearer <token>",
			]),
		).toEqual({
			name: "context7",
			transportType: "streamableHttp",
			url: "https://mcp.context7.com/mcp",
			headers: {
				Authorization: "Bearer <token>",
			},
			disabled: false,
		});
	});

	it("maps stdio MCP catalog args to command and args", () => {
		expect(
			buildMarketplaceMcpInput(["filesystem", "npx", "-y", "server", "/tmp"]),
		).toEqual({
			name: "filesystem",
			transportType: "stdio",
			command: "npx",
			args: ["-y", "server", "/tmp"],
			disabled: false,
		});
	});

	it("preserves server flags after stdio MCP command args begin", () => {
		expect(
			buildMarketplaceMcpInput([
				"search",
				"npx",
				"-y",
				"server",
				"--transport",
				"stdio",
			]),
		).toEqual({
			name: "search",
			transportType: "stdio",
			command: "npx",
			args: ["-y", "server", "--transport", "stdio"],
			disabled: false,
		});
	});

	it("TEST-QB-016/017: refuses fresh skill installation without creating a global directory", async () => {
		const fixture = mkdtempSync(join(tmpdir(), "qb-market-refusal-"));
		process.env.HOME = fixture;
		process.env.CLINE_DIR = join(fixture, ".cline");
		const target = join(fixture, ".agents", "skills");
		try {
			const spawnCommand = vi.fn(async () => ({
				exitCode: 0,
				stdout: "token=fixture-only",
				stderr: "Failed to install",
			}));
			const loadCatalog = vi.fn(async () => ({ entries: [] }));
			await expect(
				installMarketplaceEntry(
					{
						entry: {
							id: "legacy",
							type: "skill",
							install: {
								args: [
									"vercel-labs/agent-skills",
									"--skill",
									"web-design-guidelines",
								],
							},
						},
					},
					{ spawnCommand },
				),
			).rejects.toThrow("Cline marketplace is unavailable in cline-qb");
			expect(spawnCommand).not.toHaveBeenCalled();
			expect(loadCatalog).not.toHaveBeenCalled();
			expect(existsSync(target)).toBe(false);
		} finally {
			rmSync(fixture, { recursive: true, force: true });
		}
	});

	it("TEST-QB-016/017: refuses installed skill requests without changing existing bytes", async () => {
		const fixture = mkdtempSync(join(tmpdir(), "qb-market-refusal-"));
		process.env.HOME = fixture;
		process.env.CLINE_DIR = join(fixture, ".cline");
		const target = join(fixture, ".agents", "skills");
		mkdirSync(join(target, "web-design-guidelines"), { recursive: true });
		const sentinel = join(target, "web-design-guidelines", "SKILL.md");
		writeFileSync(sentinel, "existing user skill");
		try {
			const spawnCommand = vi.fn(async () => ({
				exitCode: 0,
				stdout: "token=fixture-only",
				stderr: "Failed to install",
			}));
			const loadCatalog = vi.fn(async () => ({ entries: [] }));
			await expect(
				installMarketplaceEntry(
					{
						entry: {
							id: "legacy",
							type: "skill",
							install: {
								args: [
									"vercel-labs/agent-skills",
									"--skill",
									"web-design-guidelines",
								],
							},
						},
					},
					{ spawnCommand },
				),
			).rejects.toThrow("Cline marketplace is unavailable in cline-qb");
			expect(spawnCommand).not.toHaveBeenCalled();
			expect(loadCatalog).not.toHaveBeenCalled();
			expect(readFileSync(sentinel, "utf8")).toBe("existing user skill");
		} finally {
			rmSync(fixture, { recursive: true, force: true });
		}
	});

	it("reports Cline global skills as marketplace-installed", () => {
		const clineDir = mkdtempSync(join(tmpdir(), "cline-marketplace-cline-"));
		process.env.CLINE_DIR = clineDir;
		mkdirSync(join(clineDir, "skills", "cline-sdk"), {
			recursive: true,
		});
		writeFileSync(
			join(clineDir, "skills", "cline-sdk", "SKILL.md"),
			"---\nname: cline-sdk\n---\n",
		);

		expect(
			listMarketplaceInstalledEntries({
				entries: [
					{
						id: "cline-sdk",
						type: "skill",
						name: "Cline SDK",
						install: { args: ["cline/sdk-skill"] },
					},
				],
			}),
		).toEqual({ installedKeys: ["skill:cline-sdk"] });
	});

	it("TEST-QB-016/017: refuses skill installation with a legacy Cline directory override", async () => {
		const fixture = mkdtempSync(join(tmpdir(), "qb-market-refusal-"));
		process.env.HOME = fixture;
		process.env.CLINE_DIR = join(fixture, ".cline");
		const target = join(fixture, ".agents", "skills");
		mkdirSync(process.env.CLINE_DIR, { recursive: true });
		try {
			const spawnCommand = vi.fn(async () => ({
				exitCode: 0,
				stdout: "token=fixture-only",
				stderr: "Failed to install",
			}));
			const loadCatalog = vi.fn(async () => ({ entries: [] }));
			await expect(
				installMarketplaceEntry(
					{
						entry: {
							id: "legacy",
							type: "skill",
							install: {
								args: [
									"vercel-labs/agent-skills",
									"--skill",
									"web-design-guidelines",
								],
							},
						},
					},
					{ spawnCommand },
				),
			).rejects.toThrow("Cline marketplace is unavailable in cline-qb");
			expect(spawnCommand).not.toHaveBeenCalled();
			expect(loadCatalog).not.toHaveBeenCalled();
			expect(existsSync(target)).toBe(false);
			expect(existsSync(join(process.env.CLINE_DIR, "skills"))).toBe(false);
		} finally {
			rmSync(fixture, { recursive: true, force: true });
		}
	});

	it("removes Cline global marketplace skills without prompts", async () => {
		const homeDir = mkdtempSync(join(tmpdir(), "cline-marketplace-home-"));
		process.env.HOME = homeDir;
		const skillDir = join(homeDir, ".agents", "skills", "cline-sdk");
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(join(skillDir, "SKILL.md"), "---\nname: cline-sdk\n---\n");
		const spawnCommand = vi.fn(async () => {
			rmSync(skillDir, { recursive: true, force: true });
			return {
				exitCode: 0,
				stdout: "removed",
				stderr: "",
			};
		});

		await expect(
			uninstallMarketplaceEntry(
				{
					entry: {
						id: "cline-sdk",
						type: "skill",
						name: "Cline SDK",
						install: { args: ["cline/sdk-skill"] },
					},
				},
				{ spawnCommand },
			),
		).resolves.toMatchObject({
			status: "uninstalled",
			message: "Uninstalled Cline SDK.",
		});
		expect(spawnCommand).toHaveBeenCalledWith("npx", [
			"-y",
			"skills@latest",
			"remove",
			"cline-sdk",
			"-g",
			"-y",
		]);
	});

	it("does not report project-local skills as marketplace-installed globals", () => {
		const homeDir = mkdtempSync(join(tmpdir(), "cline-marketplace-home-"));
		process.env.HOME = homeDir;

		expect(
			listMarketplaceInstalledEntries(
				{
					entries: [
						{
							id: "cline-sdk",
							type: "skill",
							name: "Cline SDK",
							install: { args: ["cline/sdk-skill"] },
						},
					],
				},
				{
					skills: [
						{
							id: "cline-sdk",
							name: "cline-sdk",
							path: "/workspace/project/.agents/skills/cline-sdk/SKILL.md",
						},
					],
				},
			),
		).toEqual({ installedKeys: [] });
	});

	it("TEST-QB-016/017: never invokes a skill installer even if it would return exit zero", async () => {
		const spawnCommand = vi.fn(async () => ({
			exitCode: 0,
			stdout: "token=fixture-only",
			stderr: "Failed to install",
		}));
		const loadCatalog = vi.fn(async () => ({ entries: [] }));
		await expect(
			installMarketplaceEntry(
				{
					entry: {
						id: "legacy",
						type: "skill",
						install: {
							args: [
								"vercel-labs/agent-skills",
								"--skill",
								"web-design-guidelines",
							],
						},
					},
				},
				{ spawnCommand },
			),
		).rejects.toThrow("Cline marketplace is unavailable in cline-qb");
		expect(spawnCommand).not.toHaveBeenCalled();
		expect(loadCatalog).not.toHaveBeenCalled();
	});

	it("TEST-QB-016/017: rejects before reading secret-bearing installer input", async () => {
		const spawnCommand = vi.fn(async () => ({
			exitCode: 0,
			stdout: "token=fixture-only",
			stderr: "Failed to install",
		}));
		const loadCatalog = vi.fn(async () => ({ entries: [] }));
		await expect(
			installMarketplaceEntry(
				{
					get entry() {
						throw new Error("fixture-secret-never-read");
					},
				},
				{ spawnCommand },
			),
		).rejects.toThrow("Cline marketplace is unavailable in cline-qb");
		expect(spawnCommand).not.toHaveBeenCalled();
		expect(loadCatalog).not.toHaveBeenCalled();
	});

	it("TEST-QB-016/017: refuses before probing an unusable global skills path", async () => {
		const fixture = mkdtempSync(join(tmpdir(), "qb-market-refusal-"));
		process.env.HOME = fixture;
		process.env.CLINE_DIR = join(fixture, ".cline");
		const target = join(fixture, ".agents", "skills");
		mkdirSync(join(fixture, ".agents"));
		writeFileSync(target, "do not replace");
		try {
			const spawnCommand = vi.fn(async () => ({
				exitCode: 0,
				stdout: "token=fixture-only",
				stderr: "Failed to install",
			}));
			const loadCatalog = vi.fn(async () => ({ entries: [] }));
			await expect(
				installMarketplaceEntry(
					{
						entry: {
							id: "legacy",
							type: "skill",
							install: {
								args: [
									"vercel-labs/agent-skills",
									"--skill",
									"web-design-guidelines",
								],
							},
						},
					},
					{ spawnCommand },
				),
			).rejects.toThrow("Cline marketplace is unavailable in cline-qb");
			expect(spawnCommand).not.toHaveBeenCalled();
			expect(loadCatalog).not.toHaveBeenCalled();
			expect(readFileSync(target, "utf8")).toBe("do not replace");
		} finally {
			rmSync(fixture, { recursive: true, force: true });
		}
	});

	it("TEST-QB-016/017: refuses missing install arguments without starting a process", async () => {
		const spawnCommand = vi.fn(async () => ({
			exitCode: 0,
			stdout: "token=fixture-only",
			stderr: "Failed to install",
		}));
		const loadCatalog = vi.fn(async () => ({ entries: [] }));
		await expect(
			installMarketplaceEntry(
				{ entry: { id: "legacy", type: "skill", install: { args: [] } } },
				{ spawnCommand },
			),
		).rejects.toThrow("Cline marketplace is unavailable in cline-qb");
		expect(spawnCommand).not.toHaveBeenCalled();
		expect(loadCatalog).not.toHaveBeenCalled();
	});

	it("TEST-QB-016/017: ignores an upstream CLI wrapper for official plugin installation", async () => {
		process.env.CLINE_WRAPPER_PATH = "/fixture/upstream-cline-must-not-execute";
		const spawnCommand = vi.fn(async () => ({
			exitCode: 0,
			stdout: "token=fixture-only",
			stderr: "Failed to install",
		}));
		const loadCatalog = vi.fn(async () => ({ entries: [] }));
		await expect(
			installMarketplaceEntry(
				{
					entry: { id: "legacy", type: "plugin", install: { args: ["goal"] } },
				},
				{ spawnCommand },
			),
		).rejects.toThrow("Cline marketplace is unavailable in cline-qb");
		expect(spawnCommand).not.toHaveBeenCalled();
		expect(loadCatalog).not.toHaveBeenCalled();
	});

	it("TEST-QB-016/017: refuses catalog MCP installation without invoking a CLI", async () => {
		const spawnCommand = vi.fn(async () => ({
			exitCode: 0,
			stdout: "token=fixture-only",
			stderr: "Failed to install",
		}));
		const loadCatalog = vi.fn(async () => ({ entries: [] }));
		await expect(
			installMarketplaceEntry(
				{
					entry: {
						id: "legacy",
						type: "mcp",
						install: {
							args: [
								"context7",
								"--transport",
								"http",
								"https://mcp.context7.com/mcp",
							],
						},
					},
				},
				{ spawnCommand },
			),
		).rejects.toThrow("Cline marketplace is unavailable in cline-qb");
		expect(spawnCommand).not.toHaveBeenCalled();
		expect(loadCatalog).not.toHaveBeenCalled();
	});

	it("uninstalls official marketplace plugins through the shared core service", async () => {
		const clineDir = mkdtempSync(join(tmpdir(), "cline-marketplace-plugin-"));
		process.env.CLINE_DIR = clineDir;
		const installPath = createInstalledOfficialPlugin(clineDir, "goal");
		const spawnCommand = vi.fn(async () => ({
			exitCode: 0,
			stdout: "",
			stderr: "",
		}));

		await expect(
			uninstallMarketplaceEntry(
				{
					entry: {
						id: "goal",
						type: "plugin",
						name: "Goal",
						install: { args: ["goal"] },
					},
				},
				{ spawnCommand },
			),
		).resolves.toMatchObject({
			status: "uninstalled",
			message: "Uninstalled Goal.",
		});

		expect(spawnCommand).not.toHaveBeenCalled();
		expect(existsSync(installPath)).toBe(false);
	});

	it("TEST-QB-016/017: refuses a cached browser install before loading its catalog", async () => {
		const spawnCommand = vi.fn(async () => ({
			exitCode: 0,
			stdout: "token=fixture-only",
			stderr: "Failed to install",
		}));
		const loadCatalog = vi.fn(async () => ({ entries: [] }));
		await expect(
			installMarketplaceEntryForDesktopCommand(
				{
					entry: {
						id: "legacy",
						type: "skill",
						install: {
							args: [
								"vercel-labs/agent-skills",
								"--skill",
								"web-design-guidelines",
							],
						},
					},
				},
				{ spawnCommand, loadCatalog },
			),
		).rejects.toThrow("Cline marketplace is unavailable in cline-qb");
		expect(spawnCommand).not.toHaveBeenCalled();
		expect(loadCatalog).not.toHaveBeenCalled();
	});

	it("TEST-QB-016/017: refuses catalog removal before loading its catalog", async () => {
		const spawnCommand = vi.fn(async () => ({
			exitCode: 0,
			stdout: "token=fixture-only",
			stderr: "Failed to install",
		}));
		const loadCatalog = vi.fn(async () => ({ entries: [] }));
		await expect(
			uninstallMarketplaceEntryForDesktopCommand(
				{
					entry: {
						id: "legacy",
						type: "skill",
						install: {
							args: [
								"vercel-labs/agent-skills",
								"--skill",
								"web-design-guidelines",
							],
						},
					},
				},
				{ spawnCommand, loadCatalog },
			),
		).rejects.toThrow("Cline marketplace is unavailable in cline-qb");
		expect(spawnCommand).not.toHaveBeenCalled();
		expect(loadCatalog).not.toHaveBeenCalled();
	});

	it("uninstalls MCP marketplace entries from Cline MCP settings", async () => {
		const settingsPath = join(
			mkdtempSync(join(tmpdir(), "cline-marketplace-mcp-")),
			"cline_mcp_settings.json",
		);
		process.env.CLINE_MCP_SETTINGS_PATH = settingsPath;
		writeFileSync(
			settingsPath,
			JSON.stringify(
				{
					mcpServers: {
						context7: {
							transport: {
								type: "streamableHttp",
								url: "https://mcp.context7.com/mcp",
							},
						},
					},
				},
				null,
				2,
			),
		);

		await expect(
			uninstallMarketplaceEntry({
				entry: {
					id: "context7",
					type: "mcp",
					name: "Context7",
					install: {
						args: [
							"context7",
							"--transport",
							"http",
							"https://mcp.context7.com/mcp",
						],
					},
				},
			}),
		).resolves.toMatchObject({
			status: "uninstalled",
			message: "Uninstalled Context7.",
		});
		expect(
			listMarketplaceInstalledEntries({
				entries: [
					{
						id: "context7",
						type: "mcp",
						name: "Context7",
						install: {
							args: [
								"context7",
								"--transport",
								"http",
								"https://mcp.context7.com/mcp",
							],
						},
					},
				],
			}),
		).toEqual({ installedKeys: [] });
	});

	it("uninstalls local MCP servers by name", async () => {
		const settingsPath = join(
			mkdtempSync(join(tmpdir(), "cline-local-mcp-")),
			"cline_mcp_settings.json",
		);
		process.env.CLINE_MCP_SETTINGS_PATH = settingsPath;
		writeFileSync(
			settingsPath,
			JSON.stringify(
				{
					mcpServers: {
						context7: {
							transport: {
								type: "streamableHttp",
								url: "https://mcp.context7.com/mcp",
							},
						},
					},
				},
				null,
				2,
			),
		);

		await expect(
			uninstallLocalPrimitive({
				type: "mcp",
				id: "context7",
				name: "context7",
			}),
		).resolves.toMatchObject({
			status: "uninstalled",
			message: "Uninstalled context7.",
		});
		expect(readFileSync(settingsPath, "utf8")).not.toContain("context7");
	});

	it("uninstalls local skills by removing their configured skill directory", async () => {
		const workspaceRoot = mkdtempSync(join(tmpdir(), "cline-local-skill-"));
		const skillDir = join(workspaceRoot, ".cline", "skills", "review");
		mkdirSync(skillDir, { recursive: true });
		const skillPath = join(skillDir, "SKILL.md");
		writeFileSync(skillPath, "---\nname: review\n---\nReview changes.");

		await expect(
			uninstallLocalPrimitive(
				{
					type: "skill",
					id: "review",
					name: "Review",
					path: skillPath,
				},
				{ workspaceRoot },
			),
		).resolves.toMatchObject({
			status: "uninstalled",
			message: "Uninstalled Review.",
		});
		expect(existsSync(skillDir)).toBe(false);
	});

	it("reports official plugin marketplace entries installed from Cline home", () => {
		const clineDir = mkdtempSync(join(tmpdir(), "cline-marketplace-test-"));
		process.env.CLINE_DIR = clineDir;
		const sourceKey =
			"official:https://github.com/cline/plugins.git#plugins/goal";
		const hash = createHash("sha256")
			.update(sourceKey)
			.digest("hex")
			.slice(0, 12);
		mkdirSync(
			join(clineDir, "plugins", "_installed", "official", `goal-${hash}`),
			{
				recursive: true,
			},
		);

		expect(
			listMarketplaceInstalledEntries({
				entries: [
					{
						id: "goal",
						type: "plugin",
						name: "Goal",
						install: { args: ["goal"] },
					},
				],
			}),
		).toEqual({ installedKeys: ["plugin:goal"] });
	});

	it("does not report plugin inventory substring matches as installed", () => {
		process.env.CLINE_DIR = mkdtempSync(
			join(tmpdir(), "cline-marketplace-test-"),
		);

		expect(
			listMarketplaceInstalledEntries(
				{
					entries: [
						{
							id: "goal",
							type: "plugin",
							name: "Goal",
							install: { args: ["goal"] },
						},
					],
				},
				{
					plugins: [
						{
							name: "goal-helper",
							path: "/workspace/.cline/plugins/goal-helper/index.ts",
						},
					],
				},
			),
		).toEqual({ installedKeys: [] });
	});

	it("skips invalid marketplace entries during installed-status checks", () => {
		const clineDir = mkdtempSync(join(tmpdir(), "cline-marketplace-test-"));
		process.env.CLINE_DIR = clineDir;
		const sourceKey =
			"official:https://github.com/cline/plugins.git#plugins/goal";
		const hash = createHash("sha256")
			.update(sourceKey)
			.digest("hex")
			.slice(0, 12);
		mkdirSync(
			join(clineDir, "plugins", "_installed", "official", `goal-${hash}`),
			{
				recursive: true,
			},
		);

		expect(
			listMarketplaceInstalledEntries({
				entries: [
					{
						id: "broken-mcp",
						type: "mcp",
						name: "Broken MCP",
						install: {
							args: [
								"broken-mcp",
								"--transport",
								"ws",
								"https://example.com/mcp",
							],
						},
					},
					{
						id: "goal",
						type: "plugin",
						name: "Goal",
						install: { args: ["goal"] },
					},
				],
			}),
		).toEqual({ installedKeys: ["plugin:goal"] });
	});

	it("TEST-QB-016/017: refuses malformed marketplace entries before argument interpretation", async () => {
		const spawnCommand = vi.fn(async () => ({
			exitCode: 0,
			stdout: "token=fixture-only",
			stderr: "Failed to install",
		}));
		const loadCatalog = vi.fn(async () => ({ entries: [] }));
		await expect(
			installMarketplaceEntry({ entry: 42 }, { spawnCommand }),
		).rejects.toThrow("Cline marketplace is unavailable in cline-qb");
		expect(spawnCommand).not.toHaveBeenCalled();
		expect(loadCatalog).not.toHaveBeenCalled();
	});

	it("TEST-QB-016/017: refuses catalog fetching despite a legacy URL override", async () => {
		vi.stubEnv(
			"CLINE_MARKETPLACE_CATALOG_URL",
			"https://fixture.invalid/legacy",
		);
		const fetchImpl = vi.fn(
			async () => new Response("unavailable", { status: 200 }),
		);
		await expect(fetchMarketplaceCatalog(fetchImpl)).rejects.toThrow(
			"Cline marketplace is unavailable in cline-qb",
		);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("TEST-QB-016/017: reports product policy without exposing upstream fetch errors", async () => {
		const fetchImpl = vi.fn(async () => {
			throw new Error("fixture-upstream-error-must-not-leak");
		});
		await expect(fetchMarketplaceCatalog(fetchImpl)).rejects.toThrow(
			"Cline marketplace is unavailable in cline-qb",
		);
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});

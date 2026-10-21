// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchMarketplaceCatalog as browserCatalog } from "../webview/src/lib/marketplace";
import {
	fetchMarketplaceCatalog,
	installMarketplaceEntry,
	installMarketplaceEntryForDesktopCommand,
	installMarketplaceEntryFromCatalog,
	uninstallMarketplaceEntryForDesktopCommand,
} from "./marketplace";
import { readMcpServersResponse, upsertMcpServer } from "./mcp";

let fixture: string;
beforeEach(() => {
	fixture = mkdtempSync(join(tmpdir(), "qb-market-boundary-"));
	vi.stubEnv("HOME", fixture);
	vi.stubEnv("CLINE_DIR", join(fixture, ".cline"));
	vi.stubEnv("CLINE_MCP_SETTINGS_PATH", join(fixture, "mcp.json"));
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	rmSync(fixture, { recursive: true, force: true });
});
describe("TEST-QB-016/017: hub Cline marketplace boundary", () => {
	it("refuses server catalog before a network request", async () => {
		const fetcher = vi.fn(async () => new Response('{"entries":[]}'));
		await expect(fetchMarketplaceCatalog(fetcher)).rejects.toThrow(
			"Cline marketplace is unavailable in cline-qb",
		);
		expect(fetcher).not.toHaveBeenCalled();
	});
	it("browser catalog remains empty without fetching", async () => {
		const fetcher = vi.fn(
			async () => new Response('{"entries":[{"id":"legacy"}]}'),
		);
		vi.stubGlobal("fetch", fetcher);
		const catalog = await browserCatalog();
		expect(catalog.entries).toEqual([]);
		expect(catalog.counts.total).toBe(0);
		expect(fetcher).not.toHaveBeenCalled();
	});
	it.each([
		"skill",
		"plugin",
		"mcp",
	])("refuses %s install through every exposed installer", async (type) => {
		const entry = {
			id: "legacy",
			type,
			install: {
				args:
					type === "mcp"
						? ["direct", "--transport", "http", "https://fixture.invalid/mcp"]
						: ["legacy"],
			},
		};
		const spawnCommand = vi.fn(async () => ({
			exitCode: 0,
			stdout: "",
			stderr: "",
		}));
		const loadCatalog = vi.fn(async () => ({ entries: [entry] }));
		for (const install of [
			installMarketplaceEntry,
			installMarketplaceEntryFromCatalog,
			installMarketplaceEntryForDesktopCommand,
		]) {
			await expect(
				install({ entry }, { spawnCommand, loadCatalog }),
			).rejects.toThrow("Cline marketplace is unavailable in cline-qb");
		}
		expect(spawnCommand).not.toHaveBeenCalled();
		expect(loadCatalog).not.toHaveBeenCalled();
	});
	it("refuses catalog-driven removal before fetching; local removal is separate", async () => {
		const loadCatalog = vi.fn(async () => ({ entries: [] }));
		await expect(
			uninstallMarketplaceEntryForDesktopCommand(
				{ entry: { id: "legacy", type: "skill" } },
				{ loadCatalog },
			),
		).rejects.toThrow("Cline marketplace is unavailable in cline-qb");
		expect(loadCatalog).not.toHaveBeenCalled();
	});
});
it("TEST-QB-016/017: direct MCP configuration remains available without catalog traffic", () => {
	const fetcher = vi.fn();
	vi.stubGlobal("fetch", fetcher);
	upsertMcpServer({
		name: "direct-user-server",
		transportType: "streamableHttp",
		url: "https://fixture.invalid/mcp",
	});
	const response = readMcpServersResponse();
	expect(response.servers).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				name: "direct-user-server",
				url: "https://fixture.invalid/mcp",
			}),
		]),
	);
	expect(fetcher).not.toHaveBeenCalled();
});

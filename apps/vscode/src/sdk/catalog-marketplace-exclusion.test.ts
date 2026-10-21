// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from "vitest"
const f = vi.hoisted(() => ({
	installMcp: vi.fn(),
	installPlugin: vi.fn(),
	spawn: vi.fn(),
	uninstall: vi.fn(),
	skills: vi.fn(async () => ({ globalSkills: [] as any[], localSkills: [] as any[] })),
}))
vi.mock("node:child_process", async (original) => ({ ...(await original<any>()), spawn: f.spawn }))
vi.mock("@cline/core", async (original) => ({
	...(await original<any>()),
	parseMcpInstallArgs: vi.fn(() => ({ name: "legacy", transport: "http", url: "https://fixture.invalid/mcp" })),
	installMcpServer: f.installMcp,
	installPlugin: f.installPlugin,
	resolvePluginConfigSearchPaths: () => [],
	readGlobalSettings: () => ({}),
	uninstallMarketplaceEntry: f.uninstall,
}))
import { MarketplaceEntry } from "@shared/proto/cline/marketplace"
import {
	fetchMarketplaceCatalog,
	installMarketplaceEntryFromCatalog,
	listInstalledMarketplaceEntries,
} from "@/core/controller/marketplace/marketplace-helpers"
import { getMarketplaceCatalog } from "@/core/controller/marketplace/getMarketplaceCatalog"
import { installMarketplaceEntry } from "@/core/controller/marketplace/installMarketplaceEntry"

afterEach(() => {
	vi.clearAllMocks()
	vi.unstubAllGlobals()
})
describe("AC-QB-016/017 Cline marketplace exclusion", () => {
	it("rejects catalog helper and RPC before network or state access", async () => {
		const fetcher = vi.fn().mockResolvedValue(new Response('{"entries":[]}'))
		vi.stubGlobal("fetch", fetcher)
		const state = { getRemoteConfigSettings: vi.fn(() => ({})) }
		await expect(fetchMarketplaceCatalog()).rejects.toMatchObject({ code: "cline_cloud_disabled" })
		await expect(getMarketplaceCatalog({ stateManager: state } as never, {})).rejects.toMatchObject({
			code: "cline_cloud_disabled",
		})
		expect(fetcher).not.toHaveBeenCalled()
		expect(state.getRemoteConfigSettings).not.toHaveBeenCalled()
	})
	it.each(["mcp", "plugin", "skill"])("rejects stale %s catalog installs at helper and RPC", async (type) => {
		f.installMcp.mockReturnValue({ warnings: [] })
		f.installPlugin.mockResolvedValue({ installPath: "/unused", mcpSyncFailures: [] })
		f.spawn.mockImplementation(() => {
			throw new Error("Unexpected subprocess")
		})
		const entry = MarketplaceEntry.create({
			id: "legacy",
			name: "Legacy",
			type,
			install: {
				args: type === "mcp" ? ["legacy", "--transport", "http", "https://fixture.invalid/mcp"] : ["legacy"],
				env: [],
			},
		})
		const controller = {
			stateManager: { getRemoteConfigSettings: vi.fn(() => ({})) },
			mcpHub: { reconcileMcpServersFromSettingsRPC: vi.fn() },
			invalidateUserInstructionService: vi.fn(),
		}
		await expect(installMarketplaceEntryFromCatalog(entry)).rejects.toMatchObject({ code: "cline_cloud_disabled" })
		await expect(installMarketplaceEntry(controller as never, { entry })).rejects.toMatchObject({
			code: "cline_cloud_disabled",
		})
		for (const spy of [
			f.installMcp,
			f.installPlugin,
			f.spawn,
			controller.stateManager.getRemoteConfigSettings,
			controller.invalidateUserInstructionService,
			controller.mcpHub.reconcileMcpServersFromSettingsRPC,
		])
			expect(spy).not.toHaveBeenCalled()
	})
	it("does not inspect installed paths for stale hosted catalog entries", () => {
		const getServers = vi.fn(() => [])
		const entry = MarketplaceEntry.create({ id: "legacy", type: "mcp", install: { args: ["legacy"], env: [] } })
		expect(listInstalledMarketplaceEntries({ mcpHub: { getServers } } as never, [entry]).installedKeys).toEqual([])
		expect(getServers).not.toHaveBeenCalled()
	})
})
vi.mock("@core/controller/file/refreshSkills", () => ({ refreshSkills: f.skills }))
import {
	listLocalMarketplaceInstalledEntries,
	toggleLocalMarketplaceInstalledEntry,
	uninstallLocalMarketplaceInstalledEntry,
} from "@/core/controller/marketplace/marketplace-helpers"
import { MarketplaceLocalInstalledEntry } from "@shared/proto/cline/marketplace"

it("keeps user-controlled MCP listing, toggle and removal available without hosted catalogs", async () => {
	const fetcher = vi.fn()
	vi.stubGlobal("fetch", fetcher)
	const server = { name: "user-controlled", status: "connected", disabled: false }
	const controller = {
		mcpHub: {
			getServers: vi.fn(() => [server]),
			toggleServerDisabledRPC: vi.fn(async (_name: string, disabled: boolean) => {
				server.disabled = disabled
			}),
			deleteServerRPC: vi.fn().mockResolvedValue(undefined),
		},
	}
	const entry = MarketplaceLocalInstalledEntry.create({ id: server.name, name: server.name, type: "mcp" })
	expect((await listLocalMarketplaceInstalledEntries(controller as never)).entries).toMatchObject([
		{ name: server.name, enabled: true },
	])
	expect((await toggleLocalMarketplaceInstalledEntry(controller as never, { entry, enabled: false })).entries).toMatchObject([
		{ name: server.name, enabled: false },
	])
	await uninstallLocalMarketplaceInstalledEntry(controller as never, { entry })
	expect(controller.mcpHub.toggleServerDisabledRPC).toHaveBeenCalledWith(server.name, true)
	expect(controller.mcpHub.deleteServerRPC).toHaveBeenCalledWith(server.name)
	for (const spy of [fetcher, f.spawn, f.installMcp, f.installPlugin]) expect(spy).not.toHaveBeenCalled()
})
vi.mock("@cline/shared/storage", async (original) => ({
	...(await original<any>()),
	resolveClineDir: () => "/private/.cline-qb",
}))
it("classifies private global paths through the storage namespace despite upstream environment overrides", async () => {
	vi.stubEnv("CLINE_DIR", "/upstream/.cline")
	try {
		f.skills.mockResolvedValueOnce({
			globalSkills: [],
			localSkills: [{ name: "private", path: "/private/.cline-qb/skills/private/SKILL.md", enabled: true }],
		})
		const entries = await listLocalMarketplaceInstalledEntries({} as never)
		expect(entries.entries[0]).toMatchObject({ name: "private", source: "global" })
	} finally {
		vi.unstubAllEnvs()
	}
})

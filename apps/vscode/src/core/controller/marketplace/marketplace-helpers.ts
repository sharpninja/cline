import { ClineCloudDisabledError } from "@cline/qbrain-governance/cloud-policy"
import { existsSync } from "node:fs"
import { resolveClineDir } from "@cline/shared/storage"
import { isAbsolute, relative, resolve } from "node:path"
import {
	disablePluginMcpServersInSettings,
	discoverPluginModulePaths,
	getPluginDisplayName,
	type MarketplaceActionResult,
	type MarketplaceEntryInput,
	type MarketplacePrimitiveType,
	readGlobalSettings,
	resolvePluginConfigSearchPaths,
	setDisabledPlugin,
	syncPluginMcpServersToSettings,
	uninstallMarketplaceEntry as uninstallCoreMarketplaceEntry,
	uninstallPlugin,
} from "@cline/core"
import { deleteSkillFile } from "@core/controller/file/deleteSkillFile"
import { refreshSkills } from "@core/controller/file/refreshSkills"
import { toggleSkill } from "@core/controller/file/toggleSkill"
import { resolveActiveModelIdFromApiConfiguration } from "@core/controller/models/taskApiModel"
import { DeleteSkillRequest, ToggleSkillRequest } from "@shared/proto/cline/file"
import {
	MarketplaceCatalog,
	MarketplaceEntry,
	MarketplaceInstalledEntries,
	MarketplaceInstallResult,
	MarketplaceLocalInstalledEntries,
	MarketplaceLocalInstalledEntry,
	MarketplaceLocalInstalledEntryRequest,
	ToggleMarketplaceLocalInstalledEntryRequest,
} from "@shared/proto/cline/marketplace"
import { HostProvider } from "@/hosts/host-provider"
import type { Controller } from "../index"

export async function fetchMarketplaceCatalog(): Promise<MarketplaceCatalog> {
	throw new ClineCloudDisabledError()
}

function normalizeMatchValue(value: string | undefined): string {
	return (value ?? "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
}

/** Normalizes an allowlist id or entry identifier; legacy allowlist ids may be GitHub repo URLs. */
function normalizePolicyValue(value: string | undefined): string {
	return normalizeMatchValue((value ?? "").replace(/^https?:\/\//i, "").replace(/\/+$/, ""))
}

/**
 * Enterprise remote config can disable the MCP marketplace (`mcpMarketplaceEnabled: false`)
 * or restrict it to an allowlist (`allowedMCPServers`). Non-MCP entries are not governed
 * by these controls. Allowlist ids match the entry id, display name, installed server
 * name, or source/homepage URL.
 */
export function isMcpEntryAllowedByPolicy(
	entry: MarketplaceEntry,
	policy: { mcpMarketplaceEnabled?: boolean; allowedMCPServers?: Array<{ id: string }> },
): boolean {
	if (entry.type !== "mcp") return true
	if (policy.mcpMarketplaceEnabled === false) return false
	if (!policy.allowedMCPServers?.length) return true
	const candidates = new Set(
		[entry.id, entry.name, getEntryArgs(entry)[0], entry.sourceUrl, entry.homepageUrl].map(normalizePolicyValue),
	)
	candidates.delete("")
	return policy.allowedMCPServers.some((server) => candidates.has(normalizePolicyValue(server.id)))
}

function getEntryArgs(entry: MarketplaceEntry): string[] {
	return entry.install?.args ?? []
}

/** Catalog entries from an old webview cannot activate hosted installation paths. */
export function listInstalledMarketplaceEntries(
	_controller: Controller,
	_entries: MarketplaceEntry[],
): MarketplaceInstalledEntries {
	return MarketplaceInstalledEntries.create({ installedKeys: [] })
}

export async function installMarketplaceEntryFromCatalog(_entry: MarketplaceEntry): Promise<MarketplaceInstallResult> {
	throw new ClineCloudDisabledError()
}

function toCoreMarketplaceEntry(entry: MarketplaceEntry): MarketplaceEntryInput {
	if (entry.type !== "mcp" && entry.type !== "skill" && entry.type !== "plugin") {
		throw new Error(`Unsupported marketplace entry type: ${entry.type}`)
	}
	return {
		id: entry.id,
		type: entry.type as MarketplacePrimitiveType,
		name: entry.name,
		install: {
			args: getEntryArgs(entry),
		},
	}
}

function toProtoMarketplaceInstallResult(result: MarketplaceActionResult): MarketplaceInstallResult {
	return MarketplaceInstallResult.create({
		id: result.id,
		type: result.type,
		status: result.status,
		message: result.message,
		output: result.output,
	})
}

export async function uninstallMarketplaceEntryFromCatalog(
	controller: Controller,
	entry: MarketplaceEntry,
): Promise<MarketplaceInstallResult> {
	const workspaceRoot = await getWorkspacePath()
	const result = await uninstallCoreMarketplaceEntry(toCoreMarketplaceEntry(entry), {
		deleteMcpServer: async (name) => {
			await controller.mcpHub?.deleteServerRPC(name)
		},
		workspaceRoot,
	})
	return toProtoMarketplaceInstallResult(result)
}

function isPathWithin(parentPath: string, childPath: string): boolean {
	const relativePath = relative(resolve(parentPath), resolve(childPath))
	return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))
}

function isGlobalClinePath(filePath: string | undefined): boolean {
	if (!filePath || filePath.startsWith("remote:")) return false
	return isPathWithin(resolveClineDir(), filePath)
}

async function listPluginLocalEntries(): Promise<MarketplaceLocalInstalledEntry[]> {
	const workspacePath = HostProvider.isInitialized() ? (await HostProvider.workspace.getWorkspacePaths({})).paths[0] : undefined
	const roots = resolvePluginConfigSearchPaths(workspacePath).filter((directory) => existsSync(directory))
	const disabledPlugins = new Set(readGlobalSettings().disabledPlugins ?? [])
	const entries: MarketplaceLocalInstalledEntry[] = []
	for (const root of roots) {
		for (const pluginPath of discoverPluginModulePaths(root)) {
			entries.push(
				MarketplaceLocalInstalledEntry.create({
					id: pluginPath,
					type: "plugin",
					name: getPluginDisplayName(pluginPath, root),
					path: pluginPath,
					source: isGlobalClinePath(pluginPath) ? "global" : "workspace",
					enabled: !disabledPlugins.has(pluginPath),
				}),
			)
		}
	}
	return entries
}

export async function listLocalMarketplaceInstalledEntries(controller: Controller): Promise<MarketplaceLocalInstalledEntries> {
	const mcpEntries = (controller.mcpHub?.getServers() ?? []).map((server) =>
		MarketplaceLocalInstalledEntry.create({
			id: server.name,
			type: "mcp",
			name: server.name,
			description: server.status,
			enabled: server.disabled !== true,
		}),
	)
	const refreshedSkills = await refreshSkills(controller)
	const skillEntries = [
		...refreshedSkills.globalSkills.map((skill) =>
			MarketplaceLocalInstalledEntry.create({
				id: skill.name,
				type: "skill",
				name: skill.name,
				description: skill.description,
				path: skill.path,
				source: skill.path.startsWith("remote:") ? "remote" : "global",
				enabled: skill.enabled,
			}),
		),
		...refreshedSkills.localSkills.map((skill) =>
			MarketplaceLocalInstalledEntry.create({
				id: skill.name,
				type: "skill",
				name: skill.name,
				description: skill.description,
				path: skill.path,
				source: isGlobalClinePath(skill.path) ? "global" : "workspace",
				enabled: skill.enabled,
			}),
		),
	]
	const pluginEntries = await listPluginLocalEntries()
	return MarketplaceLocalInstalledEntries.create({ entries: [...mcpEntries, ...skillEntries, ...pluginEntries] })
}

async function getWorkspacePath(): Promise<string | undefined> {
	return HostProvider.isInitialized() ? (await HostProvider.workspace.getWorkspacePaths({})).paths[0] : undefined
}

function getActiveProviderAndModel(controller: Controller): { providerId?: string; modelId?: string } {
	const mode = controller.stateManager.getGlobalSettingsKey("mode") === "plan" ? "plan" : "act"
	const apiConfiguration = controller.stateManager.getApiConfiguration()
	const providerId = mode === "plan" ? apiConfiguration.planModeApiProvider : apiConfiguration.actModeApiProvider
	const modelId = resolveActiveModelIdFromApiConfiguration(apiConfiguration, mode)
	return { providerId, modelId }
}

async function togglePluginLocalEntry(
	controller: Controller,
	entry: MarketplaceLocalInstalledEntry,
	enabled: boolean,
): Promise<void> {
	if (!entry.path) throw new Error("Plugin path is required.")
	if (!enabled) {
		disablePluginMcpServersInSettings({ pluginPaths: [entry.path] })
		setDisabledPlugin(entry.path, true)
		return
	}

	const workspacePath = await getWorkspacePath()
	const { providerId, modelId } = getActiveProviderAndModel(controller)
	const ownedMcpMutations = disablePluginMcpServersInSettings({ pluginPaths: [entry.path] })
	const result = await syncPluginMcpServersToSettings({
		pluginPaths: [entry.path],
		cwd: workspacePath,
		workspacePath,
		providerId,
		modelId,
	})
	if (ownedMcpMutations.length > 0 && result.failures.length > 0) {
		throw new Error(
			`Failed to sync plugin MCP servers: ${result.failures
				.map((failure) => `${failure.pluginName ?? failure.pluginPath}: ${failure.message}`)
				.join("; ")}`,
		)
	}
	setDisabledPlugin(entry.path, false)
}

export async function toggleLocalMarketplaceInstalledEntry(
	controller: Controller,
	request: ToggleMarketplaceLocalInstalledEntryRequest,
): Promise<MarketplaceLocalInstalledEntries> {
	const { entry, enabled } = request
	if (!entry) throw new Error("Installed marketplace entry is required.")
	if (entry.type === "mcp") {
		const name = entry.name || entry.id
		if (!name) throw new Error("MCP server name is required.")
		await controller.mcpHub?.toggleServerDisabledRPC(name, !enabled)
		return listLocalMarketplaceInstalledEntries(controller)
	}
	if (entry.type === "skill") {
		await toggleSkill(
			controller,
			ToggleSkillRequest.create({
				skillPath: entry.path || entry.id,
				isGlobal: entry.source === "global",
				enabled,
			}),
		)
		return listLocalMarketplaceInstalledEntries(controller)
	}
	if (entry.type === "plugin") {
		await togglePluginLocalEntry(controller, entry, enabled)
		await controller.invalidateUserInstructionService()
		return listLocalMarketplaceInstalledEntries(controller)
	}
	throw new Error(`Marketplace toggle is not supported for ${entry.type}.`)
}

export async function uninstallLocalMarketplaceInstalledEntry(
	controller: Controller,
	request: MarketplaceLocalInstalledEntryRequest,
): Promise<MarketplaceInstallResult> {
	const { entry } = request
	if (!entry) throw new Error("Installed marketplace entry is required.")
	const name = entry.name || entry.id
	if (entry.type === "mcp") {
		if (!name) throw new Error("MCP server name is required.")
		await controller.mcpHub?.deleteServerRPC(name)
		return MarketplaceInstallResult.create({
			id: entry.id,
			type: entry.type,
			status: "uninstalled",
			message: `Uninstalled ${name}.`,
		})
	}
	if (entry.type === "skill") {
		if (entry.path?.startsWith("remote:")) {
			throw new Error("Remote-managed skills cannot be uninstalled from Customize.")
		}
		if (!entry.path) throw new Error("Skill path is required for uninstall.")
		await deleteSkillFile(
			controller,
			DeleteSkillRequest.create({
				skillPath: entry.path,
				isGlobal: entry.source === "global",
			}),
		)
		await controller.invalidateUserInstructionService()
		return MarketplaceInstallResult.create({
			id: entry.id,
			type: entry.type,
			status: "uninstalled",
			message: `Uninstalled ${name || entry.id}.`,
		})
	}
	if (entry.type === "plugin") {
		const workspaceRoot = await getWorkspacePath()
		const result = await uninstallPlugin({
			name: entry.path ? undefined : name,
			path: entry.path,
			workspaceRoot,
		})
		await controller.invalidateUserInstructionService()
		return MarketplaceInstallResult.create({
			id: entry.id,
			type: entry.type,
			status: "uninstalled",
			message: `Uninstalled ${result.name}.`,
			output: [`Path: ${result.installPath}`, ...result.removedPaths.map((path) => `Removed: ${path}`)].join("\n"),
		})
	}
	throw new Error(`Marketplace uninstall is not supported for ${entry.type}.`)
}

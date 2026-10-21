import { getStorageNamespace, resolveDocumentsClineDirectoryPath, validateStoragePath } from "@cline/shared/storage"
import { Anthropic } from "@anthropic-ai/sdk"
import { TaskMetadata } from "@core/context/context-tracking/ContextTrackerTypes"
import { RemoteConfig } from "@shared/remote-config/schema"
import { GlobalState, Settings } from "@shared/storage/state-keys"
import { fileExistsAtPath, isDirectory } from "@utils/fs"
import fs from "fs/promises"
import os from "os"
import * as path from "path"
import { HostProvider } from "@/hosts/host-provider"
import { Logger } from "@/shared/services/Logger"
import { getDocumentsPath } from "./documents-path"

export { getDocumentsPath } from "./documents-path"

export { getSkillsDirectoriesForScan, type SkillsScanDirectory } from "./skill-directories"

export const GlobalFileNames = {
	apiConversationHistory: "api_conversation_history.json",
	contextHistory: "context_history.json",
	uiMessages: "ui_messages.json",
	clineRecommendedModels: "cline_recommended_models.json",
	mcpSettings: "cline_mcp_settings.json",
	clineRules: ".clinerules",
	workflows: ".clinerules/workflows",
	hooksDir: ".clinerules/hooks",
	clineruleSkillsDir: ".clinerules/skills",
	clineSkillsDir: ".cline/skills",
	claudeSkillsDir: ".claude/skills",
	agentsSkillsDir: ".agents/skills",
	cursorRulesDir: ".cursor/rules",
	cursorRulesFile: ".cursorrules",
	windsurfRules: ".windsurfrules",
	agentsRulesFile: "AGENTS.md",
	taskMetadata: "task_metadata.json",
	remoteConfig: (orgId: string) => `remote_config_${orgId}.json`,
}

export async function ensureTaskDirectoryExists(taskId: string): Promise<string> {
	return getGlobalStorageDir("tasks", taskId)
}

/** Resolve governed contributions without consulting or falling back to upstream Documents/Cline. */
async function ensureContributionDirectory(name: "Rules" | "Workflows" | "MCP" | "Hooks"): Promise<string> {
	if (getStorageNamespace()) {
		const dir = validateStoragePath(path.join(resolveDocumentsClineDirectoryPath(), name))
		await fs.mkdir(validateStoragePath(dir), { recursive: true })
		return validateStoragePath(dir)
	}
	const dir = path.join(await getDocumentsPath(), "Cline", name)
	try {
		await fs.mkdir(dir, { recursive: true })
		return dir
	} catch {
		return path.join(os.homedir(), "Documents", "Cline", name)
	}
}

export async function ensureRulesDirectoryExists(): Promise<string> {
	return ensureContributionDirectory("Rules")
}
export async function ensureWorkflowsDirectoryExists(): Promise<string> {
	return ensureContributionDirectory("Workflows")
}
export async function ensureMcpServersDirectoryExists(): Promise<string> {
	return ensureContributionDirectory("MCP")
}
export async function ensureHooksDirectoryExists(): Promise<string> {
	return ensureContributionDirectory("Hooks")
}
function getAgentSkillsDirectoryPath(): string {
	return path.join(os.homedir(), ".agents", "skills")
}

/**
 * Returns the global agent skills directory path (~/.agents/skills).
 * Creates the directory if it doesn't exist.
 * This is the opinionated location for new global skills.
 */
export async function ensureAgentSkillsDirectoryExists(options: { isGlobal: boolean; workspacePath?: string }): Promise<string> {
	const agentSkillsDir = options.isGlobal
		? getAgentSkillsDirectoryPath()
		: path.join(options.workspacePath ?? "", GlobalFileNames.agentsSkillsDir)
	try {
		await fs.mkdir(validateStoragePath(agentSkillsDir), { recursive: true })
	} catch (_error) {
		// Fallback - return the path even if mkdir fails, we'll fail gracefully later
		return validateStoragePath(agentSkillsDir)
	}
	return validateStoragePath(agentSkillsDir)
}

export async function ensureSettingsDirectoryExists(): Promise<string> {
	return getGlobalStorageDir("settings")
}

/**
 * Gets the path to the MCP settings file, creating it if it doesn't exist
 * @param settingsDirectoryPath Path to the settings directory
 * @returns Path to the MCP settings file
 */
export async function getMcpSettingsFilePath(settingsDirectoryPath: string): Promise<string> {
	const mcpSettingsFilePath = path.join(settingsDirectoryPath, GlobalFileNames.mcpSettings)
	validateStoragePath(mcpSettingsFilePath)
	const tempPath = `${mcpSettingsFilePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`
	try {
		await fs.writeFile(validateStoragePath(tempPath), JSON.stringify({ mcpServers: {} }, null, 2), {
			encoding: "utf8",
			flag: "wx",
		})
		// Hard-linking publishes the fully-written temp file without overwriting an
		// existing settings file. EEXIST means another process won the create race.
		await fs.link(validateStoragePath(tempPath), validateStoragePath(mcpSettingsFilePath))
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
			throw error
		}
	} finally {
		await fs.unlink(validateStoragePath(tempPath)).catch(() => {})
	}
	return validateStoragePath(mcpSettingsFilePath)
}

export async function getSavedApiConversationHistory(taskId: string): Promise<Anthropic.MessageParam[]> {
	const filePath = path.join(await ensureTaskDirectoryExists(taskId), GlobalFileNames.apiConversationHistory)
	const fileExists = await fileExistsAtPath(validateStoragePath(filePath))
	if (fileExists) {
		return JSON.parse(await fs.readFile(validateStoragePath(filePath), "utf8"))
	}
	return []
}

export async function getTaskMetadata(taskId: string): Promise<TaskMetadata> {
	const filePath = path.join(await ensureTaskDirectoryExists(taskId), GlobalFileNames.taskMetadata)
	try {
		if (await fileExistsAtPath(validateStoragePath(filePath))) {
			return JSON.parse(await fs.readFile(validateStoragePath(filePath), "utf8"))
		}
	} catch (error) {
		Logger.error("Failed to read task metadata:", error)
		if (getStorageNamespace()) throw error
	}
	return { files_in_context: [], model_usage: [], environment_history: [] }
}

export async function saveTaskMetadata(taskId: string, metadata: TaskMetadata) {
	try {
		const taskDir = await ensureTaskDirectoryExists(taskId)
		const filePath = path.join(taskDir, GlobalFileNames.taskMetadata)
		await writeStorageJson(filePath, metadata)
	} catch (error) {
		Logger.error("Failed to save task metadata:", error)
		if (getStorageNamespace()) throw error
	}
}

export async function ensureCacheDirectoryExists(): Promise<string> {
	return getGlobalStorageDir("cache")
}

async function writeStorageJson(filePath: string, value: unknown): Promise<void> {
	const serialized = JSON.stringify(value, null, 2)
	await fs.writeFile(validateStoragePath(filePath), serialized)
}

async function getGlobalStorageDir(...subdirs: string[]) {
	const fullPath = path.resolve(HostProvider.get().globalStorageFsPath, ...subdirs)
	await fs.mkdir(validateStoragePath(fullPath), { recursive: true })
	return validateStoragePath(fullPath)
}

export async function readTaskSettingsFromStorage(taskId: string): Promise<Partial<GlobalState>> {
	try {
		const taskDirectoryFilePath = await ensureTaskDirectoryExists(taskId)
		const settingsFilePath = path.join(taskDirectoryFilePath, "settings.json")

		if (await fileExistsAtPath(validateStoragePath(settingsFilePath))) {
			const settingsContent = await fs.readFile(validateStoragePath(settingsFilePath), "utf8")
			return JSON.parse(settingsContent)
		}

		// Return empty object if settings file doesn't exist (new task)
		return {}
	} catch (error) {
		Logger.error("[Disk] Failed to read task settings:", error)
		throw error
	}
}

export async function writeTaskSettingsToStorage(taskId: string, settings: Partial<Settings>) {
	try {
		const taskDirectoryFilePath = await ensureTaskDirectoryExists(taskId)
		const settingsFilePath = path.join(taskDirectoryFilePath, "settings.json")

		let existingSettings = {}
		if (await fileExistsAtPath(validateStoragePath(settingsFilePath))) {
			const existingSettingsContent = await fs.readFile(validateStoragePath(settingsFilePath), "utf8")
			existingSettings = JSON.parse(existingSettingsContent)
		}

		const updatedSettings = { ...existingSettings, ...settings }
		await writeStorageJson(settingsFilePath, updatedSettings)
	} catch (error) {
		Logger.error("[Disk] Failed to write task settings:", error)
		throw error
	}
}

export async function readRemoteConfigFromCache(organizationId: string): Promise<RemoteConfig | undefined> {
	try {
		const remoteConfigFilePath = path.join(await ensureCacheDirectoryExists(), GlobalFileNames.remoteConfig(organizationId))
		const fileExists = await fileExistsAtPath(validateStoragePath(remoteConfigFilePath))
		if (fileExists) {
			const fileContents = await fs.readFile(validateStoragePath(remoteConfigFilePath), "utf8")
			return JSON.parse(fileContents)
		}
		return undefined
	} catch (error) {
		Logger.error("Failed to read remote config from cache:", error)
		if (getStorageNamespace()) throw error
		return undefined
	}
}

export async function writeRemoteConfigToCache(organizationId: string, config: RemoteConfig): Promise<void> {
	try {
		const remoteConfigFilePath = path.join(await ensureCacheDirectoryExists(), GlobalFileNames.remoteConfig(organizationId))
		await writeStorageJson(remoteConfigFilePath, config)
	} catch (error) {
		Logger.error("Failed to write remote config to cache:", error)
		if (getStorageNamespace()) throw error
	}
}

export async function deleteRemoteConfigFromCache(organizationId: string): Promise<void> {
	try {
		const remoteConfigFilePath = path.join(await ensureCacheDirectoryExists(), GlobalFileNames.remoteConfig(organizationId))
		const fileExists = await fileExistsAtPath(validateStoragePath(remoteConfigFilePath))
		if (fileExists) {
			await fs.unlink(validateStoragePath(remoteConfigFilePath))
		}
	} catch (error) {
		Logger.error("Failed to delete remote config from cache:", error)
		if (getStorageNamespace()) throw error
	}
}

/**
 * Gets the path to the global hooks directory if it exists.
 * Returns undefined if the directory doesn't exist.
 */
async function getGlobalHooksDir(): Promise<string | undefined> {
	const globalHooksDir = await ensureHooksDirectoryExists()
	return (await isDirectory(validateStoragePath(globalHooksDir))) ? validateStoragePath(globalHooksDir) : undefined
}

let runtimeHooksDir: string | undefined

/**
 * Sets a runtime hooks directory, typically passed via the --hooks-dir CLI flag.
 * This directory is included alongside global and workspace hooks directories
 * when discovering hooks.
 */
export function setRuntimeHooksDir(dir: string | undefined): void {
	if (dir !== undefined) validateStoragePath(dir)
	runtimeHooksDir = dir
}

/**
 * Gets the paths to all hooks directories to search for hooks, including:
 * 1. The runtime hooks directory (if set via --hooks-dir CLI flag)
 * 2. The global hooks directory (if it exists)
 * 3. Each workspace root's .clinerules/hooks directory (if they exist)
 *
 * Note: Hooks from different directories may be executed concurrently.
 * No execution order is guaranteed between hooks from different directories.
 * A workspace may not use hooks, and the resulting array will be empty. A
 * multi-root workspace may have multiple hooks directories.
 */
export async function getAllHooksDirs(workspaceRootPaths?: string[]): Promise<string[]> {
	const hooksDirs: string[] = []

	// Add runtime hooks directory (set by --hooks-dir CLI flag)
	if (runtimeHooksDir && (await isDirectory(validateStoragePath(runtimeHooksDir)))) {
		hooksDirs.push(validateStoragePath(runtimeHooksDir))
	}

	// Add global hooks directory (if it exists)
	const globalHooksDir = await getGlobalHooksDir()
	if (globalHooksDir) {
		hooksDirs.push(globalHooksDir)
	}

	// Add workspace hooks directories
	const workspaceHooksDirs = await getWorkspaceHooksDirs(workspaceRootPaths)
	hooksDirs.push(...workspaceHooksDirs)

	return hooksDirs
}

/**
 * Resolves this window's workspace root paths for hook discovery. Workspace
 * identity must come from the window's host, not global state: ~/.cline global
 * state is shared across every Cline instance, so a persisted value can point
 * at another window's project.
 *
 * Blank entries are filtered out, and a host lookup failure degrades to no
 * workspace roots (global and runtime hooks don't depend on them).
 */
export async function getWindowWorkspaceRoots(): Promise<string[]> {
	try {
		const { paths } = await HostProvider.workspace.getWorkspacePaths({})
		return paths.filter((workspacePath) => workspacePath.trim().length > 0)
	} catch (error) {
		Logger.error("Failed to resolve workspace paths for hooks", error)
		return []
	}
}

/**
 * Gets the paths to the workspace's .clinerules/hooks directories to search for
 * hooks. A workspace may not use hooks, and the resulting array will be empty. A
 * multi-root workspace may have multiple hooks directories.
 */
export async function getWorkspaceHooksDirs(workspaceRootPaths?: string[]): Promise<string[]> {
	workspaceRootPaths ??= await getWindowWorkspaceRoots()

	return (
		await Promise.all(
			workspaceRootPaths.map(async (workspaceRootPath) => {
				// Look for a .clinerules/hooks folder in this workspace root.
				const candidate = path.join(workspaceRootPath, GlobalFileNames.hooksDir)
				return (await isDirectory(validateStoragePath(candidate))) ? validateStoragePath(candidate) : undefined
			}),
		)
	).filter((path): path is string => Boolean(path))
}

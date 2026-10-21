import { validateStoragePath } from "@cline/shared/storage"
import { HookInfo, HooksToggles, WorkspaceHooks } from "@shared/proto/cline/file"
import fs from "fs/promises"
import path from "path"
import { HostProvider } from "@/hosts/host-provider"
import { resolveExistingHookPath, resolveHooksDirectory, VALID_HOOK_TYPES } from "../../hooks/utils"
import { Controller } from ".."

export async function refreshHooks(
	_controller: Controller,
	_request?: any,
	globalHooksDirOverride?: string,
): Promise<HooksToggles> {
	const globalHooksDir = await resolveHooksDirectory(true, undefined, globalHooksDirOverride)
	const isWindows = process.platform === "win32"

	// Collect global hooks
	const globalHooks: HookInfo[] = []
	for (const hookName of VALID_HOOK_TYPES) {
		const hookPath = await resolveExistingHookPath(globalHooksDir, hookName)
		if (hookPath) {
			globalHooks.push(
				HookInfo.create({
					name: hookName,
					enabled: await isExecutable(hookPath),
					absolutePath: hookPath,
				}),
			)
		}
	}

	// Collect workspace hooks from all workspace folders
	const workspacePaths = await HostProvider.workspace.getWorkspacePaths({})
	const workspaceHooksList: WorkspaceHooks[] = []

	for (const workspacePath of workspacePaths.paths) {
		const workspaceHooksDir = path.join(workspacePath, ".clinerules", "hooks")
		const hooks: HookInfo[] = []

		for (const hookName of VALID_HOOK_TYPES) {
			const hookPath = await resolveExistingHookPath(workspaceHooksDir, hookName)
			if (hookPath) {
				hooks.push(
					HookInfo.create({
						name: hookName,
						enabled: await isExecutable(hookPath),
						absolutePath: hookPath,
					}),
				)
			}
		}

		// Add all workspaces, even if they have no hooks yet
		// This allows users to create their first hook via the dropdown
		const workspaceName = path.basename(workspacePath)
		workspaceHooksList.push(
			WorkspaceHooks.create({
				workspaceName,
				hooks,
			}),
		)
	}

	return HooksToggles.create({
		globalHooks,
		workspaceHooks: workspaceHooksList,
		isWindows,
	})
}

async function isExecutable(filePath: string): Promise<boolean> {
	validateStoragePath(filePath)
	if (process.platform === "win32") {
		// On Windows, files are "enabled" if they exist
		// TODO(PR-9552 follow-up): Replace this temporary file-exists behavior
		// with JSON-backed cross-platform hook enablement state.
		return true
	}

	try {
		await fs.access(validateStoragePath(filePath), fs.constants.X_OK)
		validateStoragePath(filePath)
		return true
	} catch {
		validateStoragePath(filePath)
		return false
	}
}

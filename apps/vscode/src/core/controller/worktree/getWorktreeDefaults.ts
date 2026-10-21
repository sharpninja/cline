import { getStorageNamespace, resolveDocumentsClineDirectoryPath, validateStoragePath } from "@cline/shared/storage"
import { EmptyRequest } from "@shared/proto/cline/common"
import { WorktreeDefaults } from "@shared/proto/cline/worktree"
import { getWorkspacePath } from "@utils/path"
import path from "path"
import { getDocumentsPath } from "@/core/storage/disk"
import { Controller } from ".."

/**
 * Generates a random suffix for worktree names
 * Returns a 5-character alphanumeric string
 */
function generateRandomSuffix(): string {
	const chars = "abcdefghijklmnopqrstuvwxyz0123456789"
	let result = ""
	for (let i = 0; i < 5; i++) {
		result += chars.charAt(Math.floor(Math.random() * chars.length))
	}
	return result
}

/**
 * Gets suggested defaults for creating a new worktree
 * @param controller The controller instance
 * @param request Empty request
 * @returns WorktreeDefaults with suggested branch name and path
 */
export async function getWorktreeDefaults(_controller: Controller, _request: EmptyRequest): Promise<WorktreeDefaults> {
	const suffix = generateRandomSuffix()

	// Generate suggested branch name
	const suggestedBranch = `worktree/${getStorageNamespace() ? "cline-qb" : "cline"}-${suffix}`

	// Governed defaults use the private host root; library consumers retain their existing location.
	const basePath = getStorageNamespace() ? resolveDocumentsClineDirectoryPath() : path.join(await getDocumentsPath(), "Cline")
	const cwd = await getWorkspacePath()

	// Get project name from workspace path
	let projectName = "project"
	if (cwd) {
		projectName = path.basename(cwd)
	}

	const suggestedPath = validateStoragePath(path.join(basePath, "Worktrees", `${projectName}-${suffix}`))

	return WorktreeDefaults.create({
		suggestedBranch,
		suggestedPath,
	})
}

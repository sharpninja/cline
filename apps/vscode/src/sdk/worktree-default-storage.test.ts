// SPDX-License-Identifier: Apache-2.0
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { registerStorageNamespace, setHomeDir } from "@cline/shared/storage"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { createQbrainStorageNamespace } from "../../../../sdk/packages/qbrain-governance/dist/storage-policy.js"
import { getWorktreeDefaults } from "../core/controller/worktree/getWorktreeDefaults"

const home = fs.mkdtempSync(path.join(os.tmpdir(), "qb-worktree-default-"))
const root = path.join(home, ".cline-qb")
const upstream = path.join(home, "Documents", "Cline")
const env: NodeJS.ProcessEnv = {}
const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(home)
let workspace: string | undefined = path.join(home, "project")
setHomeDir(home)
registerStorageNamespace(createQbrainStorageNamespace({ homeDir: home, env }))
vi.mock("../utils/path", () => ({ getWorkspacePath: async () => workspace }))
beforeEach(() => {
	fs.rmSync(home, { recursive: true, force: true })
	fs.mkdirSync(home, { recursive: true })
	delete env.CLINE_QB_DIR
	workspace = path.join(home, "project")
})
afterAll(() => {
	homedirSpy.mockRestore()
	fs.rmSync(home, { recursive: true, force: true })
})
async function defaults() {
	return getWorktreeDefaults(undefined as any, { metadata: undefined })
}
describe("AC-QB-053 worktree default storage", () => {
	it("suggests a private worktree without creating upstream storage", async () => {
		const result = await defaults()
		expect(path.dirname(result.suggestedPath)).toBe(path.join(root, "Worktrees"))
		expect(result.suggestedBranch).toMatch(/^worktree\/cline-qb-[a-z0-9]{5}$/)
		expect(path.basename(result.suggestedPath)).toMatch(/^project-[a-z0-9]{5}$/)
		expect(fs.existsSync(upstream)).toBe(false)
	})
	it("uses the permitted relocated private root", async () => {
		env.CLINE_QB_DIR = path.join(home, "relocated")
		expect(path.dirname((await defaults()).suggestedPath)).toBe(path.join(env.CLINE_QB_DIR, "Worktrees"))
	})
	it("rejects a worktree directory alias into upstream storage", async () => {
		fs.mkdirSync(upstream, { recursive: true })
		fs.mkdirSync(root)
		fs.symlinkSync(upstream, path.join(root, "Worktrees"), "junction")
		await expect(defaults()).rejects.toThrow(/upstream Cline/)
		expect(fs.readdirSync(upstream)).toEqual([])
	})
	it("keeps the no-workspace fallback inside private storage", async () => {
		workspace = undefined
		const result = await defaults()
		expect(path.dirname(result.suggestedPath)).toBe(path.join(root, "Worktrees"))
		expect(path.basename(result.suggestedPath)).toMatch(/^project-/)
	})
})

// SPDX-License-Identifier: Apache-2.0
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { registerStorageNamespace, setHomeDir } from "@cline/shared/storage"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { createQbrainStorageNamespace } from "../../../../sdk/packages/qbrain-governance/dist/storage-policy.js"
import {
	ensureRulesDirectoryExists,
	ensureWorkflowsDirectoryExists,
	ensureMcpServersDirectoryExists,
	ensureHooksDirectoryExists,
	ensureAgentSkillsDirectoryExists,
	ensureTaskDirectoryExists,
	getMcpSettingsFilePath,
	getWorkspaceHooksDirs,
	getAllHooksDirs,
	setRuntimeHooksDir,
	readTaskSettingsFromStorage,
	writeTaskSettingsToStorage,
} from "../core/storage/disk"
import { getSkillsDirectoriesForScan } from "../core/storage/skill-directories"

const home = fs.mkdtempSync(path.join(os.tmpdir(), "qb-contributions-"))
const upstream = path.join(home, ".cline")
const root = path.join(home, ".cline-qb")
const data = path.join(root, "data")
setHomeDir(home)
registerStorageNamespace(createQbrainStorageNamespace({ homeDir: home, env: {} }))
vi.mock("../hosts/host-provider", () => ({ HostProvider: { get: () => ({ globalStorageFsPath: data }) } }))
vi.mock("../core/storage/documents-path", () => ({ getDocumentsPath: async () => path.join(home, "Documents") }))

beforeEach(() => {
	fs.rmSync(home, { recursive: true, force: true })
	fs.mkdirSync(home, { recursive: true })
	setRuntimeHooksDir(undefined)
})
afterAll(() => fs.rmSync(home, { recursive: true, force: true }))
function json(file: string, value: unknown) {
	fs.mkdirSync(path.dirname(file), { recursive: true })
	fs.writeFileSync(file, JSON.stringify(value))
}

describe("AC-QB-053 extension contribution and disk boundaries", () => {
	for (const [name, create] of [
		["Rules", ensureRulesDirectoryExists],
		["Workflows", ensureWorkflowsDirectoryExists],
		["MCP", ensureMcpServersDirectoryExists],
		["Hooks", ensureHooksDirectoryExists],
	] as const) {
		it(name + " uses the private root without touching Documents/Cline", async () => {
			expect(await create()).toBe(path.join(root, name))
			expect(fs.existsSync(path.join(root, name))).toBe(true)
			expect(fs.existsSync(path.join(home, "Documents", "Cline"))).toBe(false)
		})
		it(name + " refuses an upstream alias without fallback", async () => {
			fs.mkdirSync(root, { recursive: true })
			fs.mkdirSync(upstream, { recursive: true })
			fs.symlinkSync(upstream, path.join(root, name), "junction")
			await expect(create()).rejects.toThrow(/upstream Cline/)
			expect(fs.existsSync(path.join(home, "Documents", "Cline"))).toBe(false)
		})
	}
	it("skill discovery uses private globals and preserves project contribution paths", () => {
		const project = path.join(home, "project")
		const found = getSkillsDirectoriesForScan(project)
		expect(found).toContainEqual({ path: path.join(root, "skills"), source: "global" })
		expect(found).toContainEqual({ path: path.join(project, ".cline", "skills"), source: "project" })
		expect(found.some((entry) => entry.path === path.join(upstream, "skills"))).toBe(false)
	})
	it("skill discovery rejects a workspace contribution alias", () => {
		const project = path.join(home, "project")
		fs.mkdirSync(project, { recursive: true })
		fs.mkdirSync(upstream, { recursive: true })
		fs.symlinkSync(upstream, path.join(project, ".cline"), "junction")
		expect(() => getSkillsDirectoriesForScan(project)).toThrow(/upstream Cline/)
	})
	it("agent skill creation rejects an unsafe workspace alias", async () => {
		fs.mkdirSync(upstream, { recursive: true })
		const project = path.join(home, "project")
		fs.symlinkSync(upstream, project, "junction")
		await expect(ensureAgentSkillsDirectoryExists({ isGlobal: false, workspacePath: project })).rejects.toThrow(
			/upstream Cline/,
		)
		expect(fs.existsSync(path.join(upstream, ".agents"))).toBe(false)
	})
	it("workspace hooks reject an upstream alias before probing it", async () => {
		const project = path.join(home, "project")
		fs.mkdirSync(project, { recursive: true })
		fs.mkdirSync(path.join(upstream, "hooks"), { recursive: true })
		fs.symlinkSync(upstream, path.join(project, ".clinerules"), "junction")
		await expect(getWorkspaceHooksDirs([project])).rejects.toThrow(/upstream Cline/)
	})
	it("runtime hooks reject delayed directory replacement", async () => {
		const hooks = path.join(home, "runtime-hooks")
		fs.mkdirSync(hooks)
		setRuntimeHooksDir(hooks)
		fs.rmdirSync(hooks)
		fs.mkdirSync(upstream)
		fs.symlinkSync(upstream, hooks, "junction")
		await expect(getAllHooksDirs([])).rejects.toThrow(/upstream Cline/)
	})
	it("task directory creation refuses an upstream parent alias", async () => {
		fs.mkdirSync(data, { recursive: true })
		fs.mkdirSync(upstream)
		fs.symlinkSync(upstream, path.join(data, "tasks"), "junction")
		await expect(ensureTaskDirectoryExists("task")).rejects.toThrow(/upstream Cline/)
		expect(fs.existsSync(path.join(upstream, "task"))).toBe(false)
	})
	it("MCP settings publication preflights the destination before temporary writes", async () => {
		const settings = path.join(data, "settings")
		fs.mkdirSync(settings, { recursive: true })
		json(path.join(upstream, "mcp.json"), { sentinel: true })
		fs.symlinkSync(path.join(upstream, "mcp.json"), path.join(settings, "cline_mcp_settings.json"))
		await expect(getMcpSettingsFilePath(settings)).rejects.toThrow(/upstream Cline/)
		expect(fs.readdirSync(settings)).toEqual(["cline_mcp_settings.json"])
	})
	it("task settings refuse an excluded child-file read", async () => {
		const task = path.join(data, "tasks", "task")
		fs.mkdirSync(task, { recursive: true })
		json(path.join(upstream, "settings.json"), { sentinel: true })
		fs.symlinkSync(path.join(upstream, "settings.json"), path.join(task, "settings.json"))
		await expect(readTaskSettingsFromStorage("task")).rejects.toThrow(/upstream Cline/)
	})
	it("task settings revalidate after serialization callbacks", async () => {
		const task = path.join(data, "tasks", "task")
		fs.mkdirSync(task, { recursive: true })
		json(path.join(upstream, "settings.json"), { sentinel: true })
		const settings = {
			mode: {
				toJSON() {
					fs.symlinkSync(path.join(upstream, "settings.json"), path.join(task, "settings.json"))
					return "act"
				},
			},
		} as any
		await expect(writeTaskSettingsToStorage("task", settings)).rejects.toThrow(/upstream Cline/)
		expect(JSON.parse(fs.readFileSync(path.join(upstream, "settings.json"), "utf8"))).toEqual({ sentinel: true })
	})
	it("private settings create and round trip successfully", async () => {
		await writeTaskSettingsToStorage("task", { mode: "act" })
		expect(await readTaskSettingsFromStorage("task")).toEqual({ mode: "act" })
		const settings = path.join(data, "settings")
		fs.mkdirSync(settings)
		expect(JSON.parse(fs.readFileSync(await getMcpSettingsFilePath(settings), "utf8"))).toEqual({ mcpServers: {} })
	})
})

// SPDX-License-Identifier: Apache-2.0
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { registerStorageNamespace, setHomeDir } from "@cline/shared/storage"
import { afterAll, beforeEach, describe, expect, it } from "vitest"
// Exercise the real product policy without bootstrapping against the operator's home.
import { createQbrainStorageNamespace } from "../../../../sdk/packages/qbrain-governance/dist/storage-policy.js"
import { ClineFileStorage } from "../shared/storage/ClineFileStorage"
import { createStorageContext, resolveDataDirFromEnv } from "../shared/storage/storage-context"
import {
	deleteLegacyTask,
	listTaskIds,
	readGlobalState,
	readSecrets,
	readTaskMetadata,
	resolveDataDir,
} from "./legacy-state-reader"

const home = fs.mkdtempSync(path.join(os.tmpdir(), "qb-vscode-storage-"))
const upstream = path.join(home, ".cline")
const privateRoot = path.join(home, ".cline-qb")
const data = path.join(privateRoot, "data")
setHomeDir(home)
registerStorageNamespace(createQbrainStorageNamespace({ homeDir: home, env: {} }))

beforeEach(() => {
	fs.rmSync(home, { recursive: true, force: true })
	fs.mkdirSync(home, { recursive: true })
})
afterAll(() => fs.rmSync(home, { recursive: true, force: true }))

function json(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true })
	fs.writeFileSync(file, JSON.stringify(value))
}

describe("FR-QB-018: extension file stores honor the registered host policy", () => {
	it("ignores upstream environment overrides and creates only private stores", () => {
		const old = process.env.CLINE_DATA_DIR
		process.env.CLINE_DATA_DIR = path.join(upstream, "data")
		try {
			expect(resolveDataDirFromEnv()).toBe(data)
			expect(resolveDataDir()).toBe(data)
			const storage = createStorageContext()
			expect(storage.dataDir).toBe(data)
			storage.globalStateBackingStore.setBatch({ mode: "act" })
			expect(readGlobalState()).toEqual({ mode: "act" })
			expect(fs.existsSync(upstream)).toBe(false)
		} finally {
			if (old === undefined) delete process.env.CLINE_DATA_DIR
			else process.env.CLINE_DATA_DIR = old
		}
	})

	it("refuses an excluded explicit data root before creating it", () => {
		expect(() => createStorageContext({ clineDir: upstream })).toThrow(/upstream Cline/)
		expect(fs.existsSync(upstream)).toBe(false)
	})

	it("preflights an excluded workspace override before creating either store", () => {
		expect(() => createStorageContext({ workspaceStorageDir: path.join(upstream, "workspace") })).toThrow(/upstream Cline/)
		expect(fs.existsSync(upstream)).toBe(false)
		expect(fs.existsSync(privateRoot)).toBe(false)
	})

	it("refuses direct construction over seeded upstream data", () => {
		const file = path.join(upstream, "globalState.json")
		json(file, { sentinel: true })
		expect(() => new ClineFileStorage(file)).toThrow(/upstream Cline/)
		expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ sentinel: true })
	})

	it("refuses child file aliases under an otherwise allowed data root", () => {
		const file = path.join(upstream, "globalState.json")
		json(file, { sentinel: true })
		fs.mkdirSync(data, { recursive: true })
		fs.symlinkSync(file, path.join(data, "globalState.json"))
		expect(() => createStorageContext({ clineDir: privateRoot })).toThrow(/upstream Cline/)
	})

	it("rejects a delayed directory replacement without changing cache or emitting success", () => {
		const file = path.join(data, "globalState.json")
		const upstreamFile = path.join(upstream, "globalState.json")
		json(file, { mode: "plan" })
		json(upstreamFile, { sentinel: true })
		const storage = new ClineFileStorage(file)
		let changes = 0
		storage.onDidChange(() => {
			changes++
		})
		fs.rmSync(data, { recursive: true })
		fs.symlinkSync(upstream, data, "junction")
		expect(() => storage.setBatch({ mode: "act" })).toThrow(/upstream Cline/)
		expect(storage.get("mode")).toBe("plan")
		expect(changes).toBe(0)
		expect(JSON.parse(fs.readFileSync(upstreamFile, "utf8"))).toEqual({ sentinel: true })
	})

	it("rechecks after a serialization callback redirects the storage directory", () => {
		const file = path.join(data, "globalState.json")
		const upstreamFile = path.join(upstream, "globalState.json")
		json(file, { mode: "plan" })
		json(upstreamFile, { sentinel: true })
		const storage = new ClineFileStorage(file)
		const value = {
			toJSON() {
				fs.rmSync(data, { recursive: true })
				fs.symlinkSync(upstream, data, "junction")
				return "redirected"
			},
		}
		expect(() => storage.setBatch({ mode: value })).toThrow(/upstream Cline/)
		expect(storage.get("mode")).toBe("plan")
		expect(JSON.parse(fs.readFileSync(upstreamFile, "utf8"))).toEqual({ sentinel: true })
	})
	it("refuses direct legacy-reader overrides", () => {
		json(path.join(upstream, "globalState.json"), { mode: "plan" })
		expect(() => readGlobalState(upstream)).toThrow(/upstream Cline/)
	})

	it("refuses legacy-reader child aliases instead of treating policy refusal as missing data", () => {
		const file = path.join(upstream, "secrets.json")
		json(file, { sentinel: true })
		fs.mkdirSync(data, { recursive: true })
		fs.symlinkSync(file, path.join(data, "secrets.json"))
		expect(() => readSecrets(data)).toThrow(/upstream Cline/)
	})

	it("refuses a tasks directory alias before enumeration", () => {
		fs.mkdirSync(path.join(upstream, "task-a"), { recursive: true })
		fs.mkdirSync(data, { recursive: true })
		fs.symlinkSync(upstream, path.join(data, "tasks"), "junction")
		expect(() => listTaskIds(data)).toThrow(/upstream Cline/)
	})

	it("refuses nested task artifact aliases", () => {
		json(path.join(upstream, "task_metadata.json"), { sentinel: true })
		fs.mkdirSync(path.join(data, "tasks"), { recursive: true })
		fs.symlinkSync(upstream, path.join(data, "tasks", "task-a"), "junction")
		expect(() => readTaskMetadata("task-a", data)).toThrow(/upstream Cline/)
	})

	it("preflights task deletion before rewriting history", () => {
		const history = [{ id: "task-a" }]
		json(path.join(data, "state", "taskHistory.json"), history)
		json(path.join(upstream, "sentinel.json"), { sentinel: true })
		fs.mkdirSync(path.join(data, "tasks"), { recursive: true })
		fs.symlinkSync(upstream, path.join(data, "tasks", "task-a"), "junction")
		expect(() => deleteLegacyTask("task-a", data)).toThrow(/upstream Cline/)
		expect(JSON.parse(fs.readFileSync(path.join(data, "state", "taskHistory.json"), "utf8"))).toEqual(history)
		expect(fs.existsSync(path.join(upstream, "sentinel.json"))).toBe(true)
	})

	it("retains allowed private writes, reloads, task deletion and missing-file defaults", () => {
		const storage = createStorageContext({ clineDir: privateRoot, workspacePath: home })
		storage.secrets.setBatch({ test: "fixture" })
		expect(readSecrets(data)).toEqual({ test: "fixture" })
		json(path.join(data, "state", "taskHistory.json"), [{ id: "task-a" }])
		json(path.join(data, "tasks", "task-a", "task_metadata.json"), { fixture: true })
		expect(listTaskIds(data)).toEqual(["task-a"])
		expect(deleteLegacyTask("task-a", data)).toBe(true)
		expect(listTaskIds(data)).toEqual([])
		expect(readTaskMetadata("task-a", data)).toEqual({})
		expect(fs.existsSync(upstream)).toBe(false)
	})
})

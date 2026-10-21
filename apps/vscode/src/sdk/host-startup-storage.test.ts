// SPDX-License-Identifier: Apache-2.0
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { registerStorageNamespace, setHomeDir } from "@cline/shared/storage"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { createQbrainStorageNamespace } from "../../../../sdk/packages/qbrain-governance/dist/storage-policy.js"
import { ClineEndpoint } from "../config"
import { initializeContext } from "../standalone/vscode-context"
import { JsonKeyValueStore } from "../standalone/vscode-context-utils"

vi.mock("vscode", () => ({ ExtensionMode: { Production: 1, Development: 2 }, ExtensionKind: { UI: 1 } }))

const home = fs.mkdtempSync(path.join(os.tmpdir(), "qb-host-startup-"))
const upstream = path.join(home, ".cline")
const data = path.join(home, ".cline-qb", "data")
setHomeDir(home)
registerStorageNamespace(createQbrainStorageNamespace({ homeDir: home, env: {} }))
const keys = ["CLINE_DIR", "CLINE_DATA_DIR", "WORKSPACE_STORAGE_DIR", "INSTALL_DIR", "CLINE_QB_WORKSPACE_STORAGE_DIR"]
const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]))

beforeEach(() => {
	fs.rmSync(home, { recursive: true, force: true })
	fs.mkdirSync(path.join(home, "install", "extension"), { recursive: true })
	fs.writeFileSync(path.join(home, "install", "extension", "package.json"), "{}")
	process.env.INSTALL_DIR = path.join(home, "install")
	process.env.CLINE_DIR = upstream
	process.env.CLINE_DATA_DIR = path.join(upstream, "data")
	process.env.WORKSPACE_STORAGE_DIR = path.join(upstream, "workspace")
	delete process.env.CLINE_QB_WORKSPACE_STORAGE_DIR
})
afterAll(() => {
	fs.rmSync(home, { recursive: true, force: true })
	for (const key of keys) {
		if (original[key] === undefined) delete process.env[key]
		else process.env[key] = original[key]
	}
})

describe("AC-QB-053 host startup storage consumers", () => {
	it("standalone ignores upstream overrides and constructs private state", async () => {
		const result = initializeContext()
		expect(result.DATA_DIR).toBe(data)
		expect(result.extensionContext.storageUri?.fsPath).toBe(path.join(data, "workspace"))
		await result.extensionContext.globalState.update("fixture", true)
		expect(JSON.parse(fs.readFileSync(path.join(data, "globalState.json"), "utf8"))).toEqual({ fixture: true })
		expect(fs.existsSync(upstream)).toBe(false)
	})

	it("rejects an upstream config override before making directories", () => {
		expect(() => initializeContext(upstream)).toThrow(/upstream Cline/)
		expect(fs.existsSync(upstream)).toBe(false)
	})

	it("rejects an upstream private workspace override before making directories", () => {
		process.env.CLINE_QB_WORKSPACE_STORAGE_DIR = path.join(upstream, "workspace")
		expect(() => initializeContext()).toThrow(/upstream Cline/)
		expect(fs.existsSync(upstream)).toBe(false)
		expect(fs.existsSync(data)).toBe(false)
	})

	it("standalone rejects a child-file alias before constructing any store", () => {
		fs.mkdirSync(data, { recursive: true })
		fs.mkdirSync(upstream, { recursive: true })
		fs.writeFileSync(path.join(upstream, "secrets.json"), '{"fixture":true}')
		fs.symlinkSync(path.join(upstream, "secrets.json"), path.join(data, "secrets.json"))
		expect(() => initializeContext()).toThrow(/upstream Cline/)
	})

	it("legacy key-value constructors cannot read excluded files", () => {
		fs.mkdirSync(upstream, { recursive: true })
		const file = path.join(upstream, "state.json")
		fs.writeFileSync(file, '{"fixture":true}')
		expect(() => new JsonKeyValueStore(file)).toThrow(/upstream Cline/)
	})

	it("legacy key-value delayed writes cannot follow replaced storage directories", () => {
		fs.mkdirSync(data, { recursive: true })
		const file = path.join(data, "state.json")
		fs.writeFileSync(file, '{"fixture":"old"}')
		const storage = new JsonKeyValueStore(file)
		fs.mkdirSync(upstream, { recursive: true })
		fs.writeFileSync(path.join(upstream, "state.json"), '{"sentinel":true}')
		fs.rmSync(data, { recursive: true })
		fs.symlinkSync(upstream, data, "junction")
		expect(() => storage.put("fixture", "new")).toThrow(/upstream Cline/)
		expect(storage.get("fixture")).toBe("old")
		expect(JSON.parse(fs.readFileSync(path.join(upstream, "state.json"), "utf8"))).toEqual({ sentinel: true })
	})

	it("endpoint startup uses private configuration and leaves seeded upstream configuration alone", async () => {
		const config = {
			appBaseUrl: "https://private.invalid",
			apiBaseUrl: "https://api.private.invalid",
			mcpBaseUrl: "https://mcp.private.invalid",
		}
		fs.mkdirSync(upstream, { recursive: true })
		fs.writeFileSync(path.join(upstream, "endpoints.json"), "upstream sentinel is deliberately not JSON")
		fs.mkdirSync(path.dirname(data), { recursive: true })
		fs.writeFileSync(path.join(path.dirname(data), "endpoints.json"), JSON.stringify(config))
		await ClineEndpoint.initialize(path.join(home, "install", "extension"))
		expect(ClineEndpoint.config.appBaseUrl).toBe(config.appBaseUrl)
		expect(fs.readFileSync(path.join(upstream, "endpoints.json"), "utf8")).toBe("upstream sentinel is deliberately not JSON")
	})
})

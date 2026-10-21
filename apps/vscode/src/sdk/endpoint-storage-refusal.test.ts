// SPDX-License-Identifier: Apache-2.0
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import * as fsp from "fs/promises"
import { registerStorageNamespace, setHomeDir } from "@cline/shared/storage"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { createQbrainStorageNamespace } from "../../../../sdk/packages/qbrain-governance/dist/storage-policy.js"
import { ClineEndpoint } from "../config"
vi.mock("fs/promises", async () => {
	const real = await import("node:fs")
	return { ...real.promises, access: vi.fn(real.promises.access) }
})
const home = fs.mkdtempSync(path.join(os.tmpdir(), "qb-endpoint-refusal-"))
const root = path.join(home, ".cline-qb")
const install = path.join(home, "install")
const bundled = path.join(install, "endpoints.json")
const user = path.join(root, "endpoints.json")
const excluded = path.join(home, ".cline", "endpoints.json")
setHomeDir(home)
registerStorageNamespace(createQbrainStorageNamespace({ homeDir: home, env: {} }))
const config = {
	appBaseUrl: "https://app.private.invalid",
	apiBaseUrl: "https://api.private.invalid",
	mcpBaseUrl: "https://mcp.private.invalid",
}
function write(file: string) {
	fs.mkdirSync(path.dirname(file), { recursive: true })
	fs.writeFileSync(file, JSON.stringify(config))
}
beforeEach(() => {
	fs.rmSync(home, { recursive: true, force: true })
	fs.mkdirSync(install, { recursive: true })
	;(ClineEndpoint as any)._initialized = false
	;(ClineEndpoint as any)._instance = null
	vi.mocked(fsp.access).mockImplementation(fs.promises.access)
})
afterAll(() => fs.rmSync(home, { recursive: true, force: true }))
describe("AC-QB-053 endpoint refusal", () => {
	it("bundled config replaced after access is rejected, not replaced by user fallback", async () => {
		write(bundled)
		write(user)
		write(excluded)
		vi.mocked(fsp.access).mockImplementation(async (file, mode) => {
			await fs.promises.access(file, mode)
			if (String(file) === bundled) {
				fs.unlinkSync(bundled)
				fs.symlinkSync(excluded, bundled)
			}
		})
		await expect(ClineEndpoint.initialize(install)).rejects.toThrow(/upstream Cline/)
		expect(ClineEndpoint.isInitialized()).toBe(false)
	})
	for (const target of ["bundled", "user"] as const) {
		it("inaccessible " + target + " configuration does not silently fall back", async () => {
			if (target === "bundled") write(bundled)
			write(user)
			vi.mocked(fsp.access).mockImplementation(async (file, mode) => {
				if (String(file) === (target === "bundled" ? bundled : user))
					throw Object.assign(new Error("fixture access denied"), { code: "EACCES" })
				return fs.promises.access(file, mode)
			})
			await expect(ClineEndpoint.initialize(install)).rejects.toThrow(/fixture access denied/)
			expect(ClineEndpoint.isInitialized()).toBe(false)
		})
	}
	it("absent optional bundle still permits a valid private user config", async () => {
		write(user)
		await ClineEndpoint.initialize(install)
		expect(ClineEndpoint.config.apiBaseUrl).toBe(config.apiBaseUrl)
	})
})

for (const target of ["bundled", "user"] as const) {
	it(target + " config that disappears after successful access blocks initialization", async () => {
		if (target === "bundled") write(bundled)
		write(user)
		vi.mocked(fsp.access).mockImplementation(async (file, mode) => {
			await fs.promises.access(file, mode)
			if (String(file) === (target === "bundled" ? bundled : user)) fs.unlinkSync(String(file))
		})
		await expect(ClineEndpoint.initialize(install)).rejects.toThrow()
		expect(ClineEndpoint.isInitialized()).toBe(false)
		vi.mocked(fsp.access).mockImplementation(fs.promises.access)
		write(target === "bundled" ? bundled : user)
		await ClineEndpoint.initialize(install)
		expect(ClineEndpoint.config.apiBaseUrl).toBe(config.apiBaseUrl)
	})
}

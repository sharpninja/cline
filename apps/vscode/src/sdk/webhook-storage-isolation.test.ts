// SPDX-License-Identifier: Apache-2.0
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { spawn } from "node:child_process"
import { registerStorageNamespace, setHomeDir } from "@cline/shared/storage"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { createQbrainStorageNamespace } from "../../../../sdk/packages/qbrain-governance/dist/storage-policy.js"
import { writeLgWebhookConfig, writeLgWebhookHooks } from "../services/lg-cns-integration/webhook-hooks"

const home = fs.mkdtempSync(path.join(os.tmpdir(), "qb-webhook-storage-"))
const root = path.join(home, ".cline-qb")
const upstream = path.join(home, "Documents", "Cline")
const nativePlatform = process.platform
const env: NodeJS.ProcessEnv = {}
setHomeDir(home)
registerStorageNamespace(createQbrainStorageNamespace({ homeDir: home, env }))
vi.mock("../core/storage/documents-path", () => ({ getDocumentsPath: async () => path.join(home, "Documents") }))
beforeEach(() => {
	fs.rmSync(home, { recursive: true, force: true })
	fs.mkdirSync(root, { recursive: true })
	fs.mkdirSync(upstream, { recursive: true })
	delete env.CLINE_QB_DIR
})
afterAll(() => fs.rmSync(home, { recursive: true, force: true }))
function config(file: string, url: string, token: string) {
	fs.mkdirSync(path.dirname(file), { recursive: true })
	fs.writeFileSync(file, JSON.stringify({ webhook_url: url, webhook_token: token }))
}
async function generate(platform: string) {
	Object.defineProperty(process, "platform", { value: platform })
	try {
		await writeLgWebhookHooks()
	} finally {
		Object.defineProperty(process, "platform", { value: nativePlatform })
	}
}
async function run(file: string, powershell: boolean, legacyJson = false) {
	return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
		const child = spawn(
			powershell ? "pwsh" : "node",
			powershell
				? legacyJson
					? [
							"-NoProfile",
							"-NonInteractive",
							"-Command",
							`function ConvertFrom-Json { [CmdletBinding()] param([Parameter(ValueFromPipeline=$true)][string] $InputObject) process { Microsoft.PowerShell.Utility\\ConvertFrom-Json -InputObject $InputObject } }; & '${file.replaceAll("'", "''")}'`,
						]
					: ["-NoProfile", "-NonInteractive", "-File", file]
				: [file],
			{ env: { ...process.env, HOME: home, USERPROFILE: home }, stdio: ["pipe", "pipe", "pipe"] },
		)
		let stdout = "",
			stderr = ""
		const timer = setTimeout(() => {
			child.kill()
			reject(new Error("Hook fixture timed out"))
		}, 10000)
		child.stdout.on("data", (value) => {
			stdout += value
		})
		child.stderr.on("data", (value) => {
			stderr += value
		})
		child.on("error", (error) => {
			clearTimeout(timer)
			reject(error)
		})
		child.on("close", (code) => {
			clearTimeout(timer)
			resolve({ code, stdout, stderr })
		})
		child.stdin.end(
			JSON.stringify({
				taskId: "task-fixture",
				clineVersion: "test",
				workspaceRoots: [],
				taskStart: {},
				postToolUse: { toolName: "test" },
				taskComplete: {},
			}),
		)
	})
}
async function fixture(
	action: (url: string, calls: { path: string | undefined; auth: string | undefined; body: any }[]) => Promise<void>,
) {
	const calls: { path: string | undefined; auth: string | undefined; body: any }[] = []
	const server = http.createServer((req, res) => {
		let body = ""
		req.on("data", (chunk) => {
			body += chunk
		})
		req.on("end", () => {
			calls.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(body) })
			res.writeHead(200)
			res.end("{}")
		})
	})
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject)
		server.listen(0, "127.0.0.1", resolve)
	})
	try {
		await action("http://127.0.0.1:" + (server.address() as any).port, calls)
	} finally {
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
	}
}
describe("AC-QB-053 generated webhook storage", () => {
	it("writes private configuration without modifying upstream configuration", async () => {
		const old = path.join(upstream, "webhook_config.json")
		config(old, "http://upstream.invalid", "fixture-upstream")
		const before = fs.readFileSync(old, "utf8")
		await writeLgWebhookConfig("http://private.invalid", "fixture-private")
		expect(JSON.parse(fs.readFileSync(path.join(root, "webhook_config.json"), "utf8")).webhook_token).toBe("fixture-private")
		expect(fs.readFileSync(old, "utf8")).toBe(before)
	})
	it("honors a relocated private root", async () => {
		env.CLINE_QB_DIR = path.join(home, "relocated")
		await writeLgWebhookConfig("http://private.invalid", "fixture-private")
		expect(fs.existsSync(path.join(env.CLINE_QB_DIR, "webhook_config.json"))).toBe(true)
	})
	it("rejects a configuration alias before overwriting upstream bytes", async () => {
		const old = path.join(upstream, "webhook_config.json")
		config(old, "http://upstream.invalid", "fixture-upstream")
		fs.symlinkSync(old, path.join(root, "webhook_config.json"))
		const before = fs.readFileSync(old, "utf8")
		await expect(writeLgWebhookConfig("http://private.invalid", "fixture-private")).rejects.toThrow(/upstream Cline/)
		expect(fs.readFileSync(old, "utf8")).toBe(before)
	})
	it("rejects an existing hook alias before overwriting upstream bytes", async () => {
		const old = path.join(upstream, "TaskStart")
		fs.writeFileSync(old, "sentinel")
		fs.mkdirSync(path.join(root, "Hooks"))
		fs.symlinkSync(old, path.join(root, "Hooks", "TaskStart"))
		await expect(generate("linux")).rejects.toThrow(/upstream Cline/)
		expect(fs.readFileSync(old, "utf8")).toBe("sentinel")
	})
	for (const platform of ["linux", "win32"]) {
		const powershell = platform === "win32"
		for (const [name, event] of [
			["TaskStart", "task_started"],
			["PostToolUse", "tool_executed"],
			["TaskComplete", "task_completed"],
		]) {
			it(platform + " " + name + " reads only its bound private config", async () =>
				fixture(async (url, calls) => {
					config(path.join(root, "webhook_config.json"), url + "/private", "fixture-private")
					config(path.join(upstream, "webhook_config.json"), url + "/upstream", "fixture-upstream")
					await generate(platform)
					const result = await run(path.join(root, "Hooks", name + (powershell ? ".ps1" : "")), powershell)
					expect(result.code, result.stderr).toBe(0)
					expect(JSON.parse(result.stdout)).toEqual({ cancel: false })
					expect(calls).toHaveLength(1)
					expect(calls[0].path).toBe("/private")
					expect(calls[0].auth).toBe("Bearer fixture-private")
					expect(calls[0].body.event).toBe(event)
					expect(calls[0].body.data.task_id).toBe("task-fixture")
				}),
			)
		}
		for (const alias of ["file", "parent"]) {
			it(platform + " refuses a " + alias + " alias introduced after generation", async () =>
				fixture(async (url, calls) => {
					const privateConfig = path.join(root, "webhook_config.json")
					config(privateConfig, url + "/private", "fixture-private")
					config(path.join(upstream, "webhook_config.json"), url + "/upstream", "fixture-upstream")
					await generate(platform)
					const original = path.join(root, "Hooks", "TaskStart" + (powershell ? ".ps1" : ""))
					const saved = path.join(home, "saved-hook" + (powershell ? ".ps1" : ".cjs"))
					fs.copyFileSync(original, saved)
					if (alias === "file") {
						fs.unlinkSync(privateConfig)
						fs.symlinkSync(path.join(upstream, "webhook_config.json"), privateConfig)
					} else {
						fs.renameSync(root, path.join(home, "previous-root"))
						fs.symlinkSync(upstream, root, "junction")
					}
					const result = await run(saved, powershell)
					expect(result.code).not.toBe(0)
					expect(result.stderr).toMatch(/storage|alias/i)
					expect(calls).toEqual([])
				}),
			)
		}
	}
})

for (const platform of ["linux", "win32"]) {
	const powershell = platform === "win32"
	it(platform + " optional absent config sends nothing", async () =>
		fixture(async (_url, calls) => {
			await generate(platform)
			const result = await run(path.join(root, "Hooks", "TaskStart" + (powershell ? ".ps1" : "")), powershell)
			expect(result.code, result.stderr).toBe(0)
			expect(JSON.parse(result.stdout)).toEqual({ cancel: false })
			expect(calls).toEqual([])
		}),
	)
	it(platform + " binds a private existing alias beneath a quoted relocated root", async () =>
		fixture(async (url, calls) => {
			env.CLINE_QB_DIR = path.join(home, "operator's private root")
			fs.mkdirSync(env.CLINE_QB_DIR)
			const target = path.join(home, "private-target", "webhook_config.json")
			config(target, url + "/private", "fixture-private")
			fs.symlinkSync(target, path.join(env.CLINE_QB_DIR, "webhook_config.json"))
			await generate(platform)
			const result = await run(path.join(env.CLINE_QB_DIR, "Hooks", "TaskStart" + (powershell ? ".ps1" : "")), powershell)
			expect(result.code, result.stderr).toBe(0)
			expect(calls).toHaveLength(1)
			expect(calls[0].path).toBe("/private")
			expect(calls[0].body.data.task_id).toBe("task-fixture")
		}),
	)
}

// Windows PowerShell 5's JSON parser has no Depth parameter. Execute the real
// generated script with that parameter surface, preserving the actual parser.
for (const [name, event] of [
	["TaskStart", "task_started"],
	["PostToolUse", "tool_executed"],
	["TaskComplete", "task_completed"],
]) {
	it("legacy PowerShell JSON binding preserves " + name + " webhook delivery", async () =>
		fixture(async (url, calls) => {
			config(path.join(root, "webhook_config.json"), url + "/private", "fixture-private")
			await generate("win32")
			const result = await run(path.join(root, "Hooks", name + ".ps1"), true, true)
			expect(result.code, result.stderr).toBe(0)
			expect(JSON.parse(result.stdout)).toEqual({ cancel: false })
			expect(calls).toHaveLength(1)
			expect(calls[0].body.event).toBe(event)
			expect(calls[0].body.data.task_id).toBe("task-fixture")
			expect(calls[0].auth).toBe("Bearer fixture-private")
		}),
	)
}

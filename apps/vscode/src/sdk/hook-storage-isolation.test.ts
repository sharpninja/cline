// SPDX-License-Identifier: Apache-2.0
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { registerStorageNamespace, setHomeDir } from "@cline/shared/storage"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { createQbrainStorageNamespace } from "../../../../sdk/packages/qbrain-governance/dist/storage-policy.js"
import { HookFactory } from "../core/hooks/hook-factory"
import { HookDiscoveryCache } from "../core/hooks/HookDiscoveryCache"
import { HookProcess, getHookLaunchConfig, resetHookLaunchConfigCacheForTesting } from "../core/hooks/HookProcess"
import { resolveHooksDirectory, resolveExistingHookPath } from "../core/hooks/utils"
import { createHook } from "../core/controller/file/createHook"
import { toggleHook } from "../core/controller/file/toggleHook"
import { deleteHook } from "../core/controller/file/deleteHook"
import { refreshHooks } from "../core/controller/file/refreshHooks"

const home = fs.mkdtempSync(path.join(os.tmpdir(), "qb-hook-storage-"))
const upstream = path.join(home, ".cline")
const root = path.join(home, ".cline-qb")
const hooks = path.join(root, "Hooks")
const project = path.join(home, "project")
const nativePlatform = process.platform
const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(home)
setHomeDir(home)
registerStorageNamespace(createQbrainStorageNamespace({ homeDir: home, env: {} }))
vi.mock("../hosts/host-provider", () => ({
	HostProvider: {
		get: () => ({ globalStorageFsPath: path.join(root, "data") }),
		workspace: { getWorkspacePaths: async () => ({ paths: [project] }) },
	},
}))
vi.mock("../services/telemetry", () => ({ telemetryService: { safeCapture: () => {} } }))

beforeEach(() => {
	HookDiscoveryCache.resetForTesting()
	resetHookLaunchConfigCacheForTesting()
	fs.rmSync(home, { recursive: true, force: true })
	fs.mkdirSync(project, { recursive: true })
})
afterAll(() => {
	HookDiscoveryCache.resetForTesting()
	homedirSpy.mockRestore()
	fs.rmSync(home, { recursive: true, force: true })
})
function script(file: string, content = "#!/bin/sh\ncat >/dev/null\nprintf '{}\\n'\n") {
	fs.mkdirSync(path.dirname(file), { recursive: true })
	fs.writeFileSync(file, content, { mode: 0o755 })
}
function aliasHook(file = path.join(hooks, "TaskStart")) {
	const excluded = path.join(upstream, "TaskStart")
	script(excluded)
	fs.mkdirSync(path.dirname(file), { recursive: true })
	fs.symlinkSync(excluded, file)
	return file
}

describe("AC-QB-053 hook consumers", () => {
	it("relative directory inputs are bound to the caller's current directory", async () => {
		const a = path.join(home, "a", "hooks", "TaskStart")
		const b = path.join(home, "b", "hooks", "TaskStart")
		script(a)
		script(b)
		const originalCwd = process.cwd()
		process.chdir(path.dirname(path.dirname(a)))
		try {
			const cache = HookDiscoveryCache.getInstance()
			const first = await cache.get("TaskStart", ["hooks"])
			process.chdir(path.dirname(path.dirname(b)))
			const second = await cache.get("TaskStart", ["hooks"])
			expect([first, second]).toEqual([[a], [b]])
		} finally {
			process.chdir(originalCwd)
		}
	})
	it("concurrent hook creation publishes exactly one complete template", async () => {
		const request = { metadata: undefined, hookName: "TaskStart", isGlobal: true, workspaceName: "" }
		const results = await Promise.allSettled([createHook(undefined as any, request), createHook(undefined as any, request)])
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(1)
		expect(fs.readFileSync(path.join(hooks, "TaskStart"), "utf8")).toContain("# TaskStart Hook")
	})
	it("spawn-error reporting returns a policy error instead of throwing from the event callback", () => {
		const cwd = path.join(home, "delayed-cwd")
		fs.mkdirSync(cwd)
		const runner = new HookProcess(path.join(hooks, "TaskStart"), 3000, undefined, cwd)
		fs.rmdirSync(cwd)
		fs.mkdirSync(upstream)
		fs.symlinkSync(upstream, cwd, "junction")
		const error = Object.assign(new Error("missing"), { code: "ENOENT" })
		expect(() => {
			;(runner as any).describeSpawnError(error)
		}).not.toThrow()
		expect((runner as any).describeSpawnError(error).message).toMatch(/upstream Cline/)
	})
	it("a scan captures its directory list before the caller can mutate it", async () => {
		const a = path.join(home, "a", "TaskStart")
		const b = path.join(home, "b", "TaskStart")
		script(a)
		script(b)
		const dirs = [path.dirname(a)]
		const result = HookDiscoveryCache.getInstance().get("TaskStart", dirs)
		dirs[0] = path.dirname(b)
		expect(await result).toEqual([a])
	})
	it("returned lists cannot mutate another caller's cached result", async () => {
		const a = path.join(home, "a", "TaskStart")
		const b = path.join(home, "b", "TaskStart")
		script(a)
		script(b)
		const cache = HookDiscoveryCache.getInstance()
		const first = await cache.get("TaskStart", [path.dirname(a)])
		first.push(b)
		expect(await cache.get("TaskStart", [path.dirname(a)])).toEqual([a])
	})
	it("global hook UI resolves the private directory", async () => {
		expect(await resolveHooksDirectory(true)).toBe(hooks)
	})
	it("global UI override rejects upstream storage", async () => {
		await expect(resolveHooksDirectory(true, undefined, upstream)).rejects.toThrow(/upstream Cline/)
	})
	it("UI discovery refuses an excluded script alias", async () => {
		aliasHook()
		await expect(resolveExistingHookPath(hooks, "TaskStart")).rejects.toThrow(/upstream Cline/)
	})
	it("factory discovery refuses an excluded Unix script alias", async () => {
		aliasHook()
		await expect(HookFactory.findHookInHooksDir("TaskStart", hooks)).rejects.toThrow(/upstream Cline/)
	})
	it("factory discovery refuses an excluded Windows script alias", async () => {
		aliasHook(path.join(hooks, "TaskStart.ps1"))
		Object.defineProperty(process, "platform", { value: "win32" })
		try {
			await expect(HookFactory.findHookInHooksDir("TaskStart", hooks)).rejects.toThrow(/upstream Cline/)
		} finally {
			Object.defineProperty(process, "platform", { value: nativePlatform })
		}
	})
	it("launch configuration refuses upstream scripts", async () => {
		await expect(getHookLaunchConfig(path.join(upstream, "TaskStart"))).rejects.toThrow(/upstream Cline/)
	})
	it("Windows launch rechecks the script after launcher lookup", async () => {
		const file = path.join(hooks, "TaskStart.ps1")
		script(file)
		script(path.join(upstream, "TaskStart.ps1"))
		Object.defineProperty(process, "platform", { value: "win32" })
		try {
			await expect(
				getHookLaunchConfig(file, async () => {
					fs.unlinkSync(file)
					fs.symlinkSync(path.join(upstream, "TaskStart.ps1"), file)
					return "powershell.exe"
				}),
			).rejects.toThrow(/upstream Cline/)
		} finally {
			Object.defineProperty(process, "platform", { value: nativePlatform })
			resetHookLaunchConfigCacheForTesting()
		}
	})
	it("delayed process launch rejects an excluded alias without executing it", async () => {
		const file = path.join(hooks, "TaskStart")
		const marker = path.join(home, "executed")
		script(file)
		const runner = new HookProcess(file, 3000, undefined, project)
		fs.unlinkSync(file)
		script(path.join(upstream, "TaskStart"), "#!/bin/sh\ncat >/dev/null\ntouch '" + marker + "'\n")
		fs.symlinkSync(path.join(upstream, "TaskStart"), file)
		await expect(runner.run("{}")).rejects.toThrow(/upstream Cline/)
		expect(fs.existsSync(marker)).toBe(false)
	})
	it("allowed private hooks still execute", async () => {
		const file = path.join(hooks, "TaskStart")
		const marker = path.join(home, "allowed-executed")
		script(file, "#!/bin/sh\ncat >/dev/null\ntouch '" + marker + "'\n")
		await new HookProcess(file, 3000, undefined, project).run("{}")
		expect(fs.existsSync(marker)).toBe(true)
	})
	it("excluded hook working directories cannot be used", async () => {
		const file = path.join(hooks, "TaskStart")
		script(file)
		fs.mkdirSync(upstream)
		await expect(new HookProcess(file, 3000, undefined, upstream).run("{}")).rejects.toThrow(/upstream Cline/)
	})
	it("cache refuses unsafe directories before watcher creation", async () => {
		const watch = vi.fn(() => null)
		const cache = HookDiscoveryCache.getInstance()
		cache.initialize({ subscriptions: [] }, watch)
		await expect(cache.get("TaskStart", [upstream])).rejects.toThrow(/upstream Cline/)
		expect(watch).not.toHaveBeenCalled()
	})
	it("cached script paths are revalidated after replacement", async () => {
		const file = path.join(hooks, "TaskStart")
		script(file)
		const cache = HookDiscoveryCache.getInstance()
		expect(await cache.get("TaskStart", [hooks])).toEqual([file])
		fs.unlinkSync(file)
		aliasHook(file)
		await expect(cache.get("TaskStart", [hooks])).rejects.toThrow(/upstream Cline/)
	})
	it("failed discovery can retry after an unsafe alias is repaired", async () => {
		const file = aliasHook()
		const cache = HookDiscoveryCache.getInstance()
		await expect(cache.get("TaskStart", [hooks])).rejects.toThrow(/upstream Cline/)
		fs.unlinkSync(file)
		script(file)
		expect(await cache.get("TaskStart", [hooks])).toEqual([file])
	})
	it("private global hooks retain global attribution and workspace cwd", async () => {
		script(path.join(hooks, "TaskStart"))
		const runner = await new HookFactory().create("TaskStart")
		expect(runner.isNoOp).toBe(false)
		expect((runner as any).source).toBe("global")
		expect((runner as any).cwd).toBe(project)
	})
	it("hook UI creates, toggles, lists and deletes private hooks", async () => {
		const controller = undefined as any
		await createHook(controller, { metadata: undefined, hookName: "TaskStart", isGlobal: true, workspaceName: "" })
		const file = path.join(hooks, "TaskStart")
		expect(fs.existsSync(file)).toBe(true)
		await toggleHook(controller, {
			metadata: undefined,
			hookName: "TaskStart",
			isGlobal: true,
			enabled: true,
			workspaceName: "",
		})
		const result = await refreshHooks(controller)
		expect(result.globalHooks).toContainEqual(
			expect.objectContaining({ name: "TaskStart", absolutePath: file, enabled: true }),
		)
		await deleteHook(controller, { metadata: undefined, hookName: "TaskStart", isGlobal: true, workspaceName: "" })
		expect(fs.existsSync(file)).toBe(false)
	})
	it("cache scopes sequential callers to their directory snapshots", async () => {
		const a = path.join(home, "a", "TaskStart")
		const b = path.join(home, "b", "TaskStart")
		script(a)
		script(b)
		const cache = HookDiscoveryCache.getInstance()
		expect(await cache.get("TaskStart", [path.dirname(a)])).toEqual([a])
		expect(await cache.get("TaskStart", [path.dirname(b)])).toEqual([b])
	})
	it("concurrent scans never share results across directory snapshots", async () => {
		const a = path.join(home, "a", "TaskStart")
		const b = path.join(home, "b", "TaskStart")
		script(a)
		script(b)
		const cache = HookDiscoveryCache.getInstance()
		expect(await Promise.all([cache.get("TaskStart", [path.dirname(a)]), cache.get("TaskStart", [path.dirname(b)])])).toEqual(
			[[a], [b]],
		)
	})
	it("deleting an allowed hook symlink preserves its target", async () => {
		const target = path.join(home, "allowed", "TaskStart")
		script(target)
		fs.mkdirSync(hooks, { recursive: true })
		const link = path.join(hooks, "TaskStart")
		fs.symlinkSync(target, link)
		await deleteHook(
			undefined as any,
			{ metadata: undefined, hookName: "TaskStart", isGlobal: true, workspaceName: "" },
			hooks,
		)
		expect(fs.existsSync(link)).toBe(false)
		expect(fs.existsSync(target)).toBe(true)
	})
	for (const action of ["refresh", "toggle", "delete"] as const) {
		it(action + " rejects an excluded hook alias without mutation", async () => {
			const file = aliasHook()
			const before = fs.readFileSync(path.join(upstream, "TaskStart"), "utf8")
			const request = { metadata: undefined, hookName: "TaskStart", isGlobal: true, enabled: false, workspaceName: "" }
			const call =
				action === "refresh"
					? refreshHooks(undefined as any, undefined, hooks)
					: action === "toggle"
						? toggleHook(undefined as any, request, hooks)
						: deleteHook(undefined as any, request, hooks)
			await expect(call).rejects.toThrow(/upstream Cline/)
			expect(fs.lstatSync(file).isSymbolicLink()).toBe(true)
			expect(fs.readFileSync(path.join(upstream, "TaskStart"), "utf8")).toBe(before)
		})
	}
})

import { beforeEach, describe, expect, it, vi } from "vitest"
const f = vi.hoisted(() => ({ prepare: vi.fn(), files: vi.fn(), clear: vi.fn(), apply: vi.fn(), mkdir: vi.fn() }))
vi.mock("@cline/core", () => ({ prepareRemoteConfigCoreIntegration: f.prepare }))
vi.mock("@cline/shared", () => ({ clearMaterializedRemoteConfigRuntime: f.files }))
vi.mock("node:fs/promises", () => ({ mkdir: f.mkdir }))
vi.mock("./utils", () => ({ clearRemoteConfig: f.clear, applyRemoteConfig: f.apply }))
vi.mock("./sdk-control-plane", () => ({
	SdkRemoteConfigControlPlane: class {
		wasExplicitNoConfig() {
			return true
		}
		getLastRemoteConfig() {
			return undefined
		}
		getLastConfiguredKeys() {
			return {}
		}
		isRemoteConfigAvailable() {
			return false
		}
	},
}))
vi.mock("@/services/telemetry", () => ({ telemetryService: { captureRemoteConfigRefresh: vi.fn() } }))
import { clearSdkRemoteConfig, refreshSdkRemoteConfig } from "./sdk-refresh"
function controller() {
	return {
		setRemoteConfigAvailable: vi.fn(),
		setRemoteConfigCoreIntegration: vi.fn().mockResolvedValue(undefined),
		postStateToWebview: vi.fn().mockResolvedValue(undefined),
		authService: { getActiveOrganizationId: () => "old-org" },
		stateManager: { setGlobalState: vi.fn() },
		mcpHub: {},
	}
}
beforeEach(() => {
	vi.resetAllMocks()
	f.clear.mockResolvedValue(undefined)
	f.prepare.mockResolvedValue({ dispose: async () => {}, prepared: { bundle: { version: "legacy" } } })
})
function noHostedWork() {
	for (const spy of [f.prepare, f.files, f.apply, f.mkdir]) expect(spy).not.toHaveBeenCalled()
}
describe("Cline remote refresh exclusion", () => {
	for (const workspacePath of [undefined, "/upstream/.cline", "C:\\Users\\operator\\.cline"]) {
		it("clears only runtime policy without materializing or deleting files: " + workspacePath, async () => {
			const c = controller()
			expect(await refreshSdkRemoteConfig(c as never, { workspacePath })).toBe(true)
			expect(f.clear).toHaveBeenCalledTimes(1)
			expect(c.setRemoteConfigAvailable).toHaveBeenCalledWith(false)
			expect(c.setRemoteConfigCoreIntegration).toHaveBeenCalledWith(undefined)
			expect(c.postStateToWebview).toHaveBeenCalledTimes(1)
			noHostedWork()
		})
	}
	it("sign-out ignores upstream workspace and organization paths", async () => {
		const c = controller()
		await clearSdkRemoteConfig(c as never, { workspacePath: "/upstream/.cline", organizationId: "old-org" })
		expect(f.clear).toHaveBeenCalledWith()
		expect(c.setRemoteConfigCoreIntegration).toHaveBeenCalledWith(undefined)
		noHostedWork()
	})
	it("ignores a stale generation without publishing state", async () => {
		const c = controller()
		expect(await refreshSdkRemoteConfig(c as never, { isCurrent: () => false })).toBe(false)
		expect(f.clear).not.toHaveBeenCalled()
		expect(c.postStateToWebview).not.toHaveBeenCalled()
		noHostedWork()
	})
	it("serializes refresh and clear and awaits provider removal", async () => {
		let release!: () => void
		f.clear.mockImplementationOnce(
			() =>
				new Promise<void>((r) => {
					release = r
				}),
		)
		const c = controller()
		const first = refreshSdkRemoteConfig(c as never)
		const second = clearSdkRemoteConfig(c as never)
		await vi.waitFor(() => expect(f.clear).toHaveBeenCalledTimes(1))
		expect(c.setRemoteConfigCoreIntegration).not.toHaveBeenCalled()
		release()
		await Promise.all([first, second])
		expect(f.clear).toHaveBeenCalledTimes(2)
		expect(c.setRemoteConfigCoreIntegration).toHaveBeenCalledTimes(2)
		noHostedWork()
	})
	it("does not publish a refresh superseded during cleanup", async () => {
		let current = true
		f.clear.mockImplementation(async () => {
			current = false
		})
		const c = controller()
		expect(await refreshSdkRemoteConfig(c as never, { isCurrent: () => current })).toBe(false)
		expect(c.setRemoteConfigCoreIntegration).not.toHaveBeenCalled()
		expect(c.postStateToWebview).not.toHaveBeenCalled()
		noHostedWork()
	})
	it("reports local cleanup failure without hosted or cached fallback", async () => {
		f.clear.mockRejectedValue(new Error("local cleanup failed"))
		await expect(refreshSdkRemoteConfig(controller() as never)).rejects.toThrow("local cleanup failed")
		noHostedWork()
	})
})

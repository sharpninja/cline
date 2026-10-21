import { beforeEach, describe, expect, it, vi } from "vitest"
import discoveryFixture from "@/core/storage/remote-config/fixtures/user-remote-config-discovery.json"

const {
	fetchUserRemoteConfig,
	switchAccount,
	setSecret,
	isRemoteConfigEnabled,
	writeRemoteConfigToCache,
	readRemoteConfigFromCache,
	activeOrganization,
	axiosRequest,
} = vi.hoisted(() => ({
	fetchUserRemoteConfig: vi.fn(),
	switchAccount: vi.fn(),
	setSecret: vi.fn(),
	isRemoteConfigEnabled: vi.fn(),
	writeRemoteConfigToCache: vi.fn(),
	readRemoteConfigFromCache: vi.fn(),
	activeOrganization: { id: "org-current" as string | null },
	axiosRequest: vi.fn(),
}))

vi.mock("@/services/auth/AuthService", () => ({
	AuthService: {
		getInstance: () => ({
			getActiveOrganizationId: () => activeOrganization.id,
			getAuthToken: async () => "token",
		}),
	},
}))

vi.mock("@/core/storage/disk", () => ({
	deleteRemoteConfigFromCache: vi.fn(),
	readRemoteConfigFromCache,
	writeRemoteConfigToCache,
}))

vi.mock("@/core/storage/remote-config/utils", () => ({
	isRemoteConfigEnabled,
}))

vi.mock("@/config", () => ({ ClineEnv: { config: () => ({ apiBaseUrl: "https://api.example.test" }) } }))
vi.mock("@/services/EnvUtils", () => ({ buildBasicClineHeaders: async () => ({}) }))
vi.mock("@/shared/net", () => ({ getAxiosSettings: () => ({}) }))
vi.mock("axios", () => ({ default: { request: axiosRequest } }))

import { SdkRemoteConfigControlPlane } from "@/core/storage/remote-config/sdk-control-plane"

describe("SdkRemoteConfigControlPlane", () => {
	beforeEach(() => {
		fetchUserRemoteConfig.mockReset()
		switchAccount.mockReset()
		setSecret.mockReset()
		isRemoteConfigEnabled.mockReset().mockReturnValue(true)
		writeRemoteConfigToCache.mockReset().mockResolvedValue(undefined)
		readRemoteConfigFromCache.mockReset().mockResolvedValue({ version: "v1" })
		activeOrganization.id = "org-current"
		lastManagedOrganization.id = undefined
		axiosRequest.mockReset().mockRejectedValue(new Error("offline"))
	})

	const lastManagedOrganization = { id: undefined as string | undefined }

	function makeControlPlane() {
		return new SdkRemoteConfigControlPlane({
			accountService: { switchAccount, fetchUserRemoteConfig },
			stateManager: {
				setSecret,
				getGlobalStateKey: ((key: string) =>
					key === "lastManagedOrganizationId" ? lastManagedOrganization.id : {}) as never,
			},
		})
	}

	for (const organization of [null, "org-current"])
		for (const optedIn of [false, true]) {
			it("ignores hosted discovery and cache, organization=" + organization + ", optedIn=" + optedIn, async () => {
				activeOrganization.id = organization
				lastManagedOrganization.id = "old-org"
				isRemoteConfigEnabled.mockReturnValue(optedIn)
				fetchUserRemoteConfig.mockResolvedValue(discoveryFixture)
				const controlPlane = makeControlPlane()
				const results = await Promise.all([
					controlPlane.fetchBundle({ workspacePath: "/upstream/.cline" }),
					controlPlane.fetchBundle({ workspacePath: "/other" }),
				])
				expect(results).toEqual([undefined, undefined])
				expect(controlPlane.getLastConfiguredKeys()).toEqual({})
				expect(controlPlane.getLastRemoteConfig()).toBeUndefined()
				expect(controlPlane.wasExplicitNoConfig()).toBe(true)
				expect(controlPlane.isRemoteConfigAvailable()).toBe(false)
				for (const spy of [
					fetchUserRemoteConfig,
					switchAccount,
					setSecret,
					axiosRequest,
					readRemoteConfigFromCache,
					writeRemoteConfigToCache,
				])
					expect(spy).not.toHaveBeenCalled()
			})
		}
	it("does no remote work for an already aborted request", async () => {
		const signal = AbortSignal.abort()
		const controlPlane = makeControlPlane()
		expect(await controlPlane.fetchBundle({ workspacePath: "/unused", signal })).toBeUndefined()
		expect(fetchUserRemoteConfig).not.toHaveBeenCalled()
		expect(readRemoteConfigFromCache).not.toHaveBeenCalled()
	})
})

// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from "vitest"
import { getStateToPostToWebview } from "@/core/controller/state/getStateToPostToWebview"
import { dismissBanner } from "@/core/controller/state/dismissBanner"
import { trackBannerEvent } from "@/core/controller/state/trackBannerEvent"

const f = vi.hoisted(() => ({ getBanner: vi.fn(), dismiss: vi.fn(), event: vi.fn(), active: vi.fn(), welcome: vi.fn() }))
vi.mock("@cline/core", () => ({ isModelToolEnabledGlobally: () => false, readCompactionStrategyGlobally: () => "none" }))
vi.mock("@core/hooks/hooks-utils", () => ({ getHooksEnabledSafe: () => false }))
vi.mock("@/config", () => ({ ClineEnv: { config: () => ({ environment: "production" }) } }))
vi.mock("@/registry", () => ({ ExtensionRegistryInfo: { version: "test" } }))
vi.mock("@/services/banner/BannerService", () => ({ BannerService: { get: f.getBanner } }))
vi.mock("@/services/feature-flags", () => ({ featureFlagsService: { getWorktreesEnabled: () => true } }))
vi.mock("@/services/logging/distinctId", () => ({ getDistinctId: () => "synthetic-local-id" }))
vi.mock("@/services/telemetry/rollout-metadata", () => ({ getExtensionVariant: () => "private" }))
vi.mock("@/utils/announcements", () => ({ getLatestAnnouncementId: () => "local" }))
vi.mock("@/core/controller/models/getClineOnboardingModels", () => ({ getClineOnboardingModels: () => [] }))
vi.mock("@/integrations/openai-codex/oauth", () => ({ openAiCodexOAuthManager: { isAuthenticated: async () => true } }))
vi.mock("@/shared/services/Logger", () => ({ Logger: { error: vi.fn() } }))
const oldUser = { uid: "old-hosted-user", email: "synthetic@example.invalid" }
function controller() {
	return {
		postStateToWebview: vi.fn().mockResolvedValue(undefined),
		stateManager: {
			getApiConfiguration: () => ({ actModeApiProvider: "anthropic", planModeApiProvider: "anthropic" }),
			getGlobalStateKey: (key: string) => (key === "userInfo" ? oldUser : key === "taskHistory" ? [] : undefined),
			getGlobalSettingsKey: () => undefined,
			getWorkspaceStateKey: () => undefined,
			getRemoteConfigSettings: () => ({}),
		},
	}
}
beforeEach(() => {
	vi.resetAllMocks()
	f.active.mockReturnValue([{ id: "legacy-hosted-banner" }])
	f.welcome.mockReturnValue([{ id: "legacy-welcome-banner" }])
	f.getBanner.mockReturnValue({
		getActiveBanners: f.active,
		getWelcomeBanners: f.welcome,
		dismissBanner: f.dismiss,
		sendBannerEvent: f.event,
	})
})
describe("AC-QB-016/017 account-independent webview state", () => {
	for (const initialized of [false, true]) {
		it("publishes usable signed-out state without hosted banners, initialized=" + initialized, async () => {
			if (!initialized)
				f.getBanner.mockImplementation(() => {
					throw new Error("BannerService not initialized")
				})
			const state = await getStateToPostToWebview(controller())
			expect(state.userInfo).toBeUndefined()
			expect(state.banners).toEqual([])
			expect(state.welcomeBanners).toEqual([])
			expect(state.openAiCodexIsAuthenticated).toBe(true)
			expect(state.apiConfiguration?.actModeApiProvider).toBe("anthropic")
			expect(f.getBanner).not.toHaveBeenCalled()
		})
	}
	it("dismisses a stale browser banner locally without reaching the hosted service", async () => {
		const c = controller()
		expect(await dismissBanner(c as any, { value: "old-banner" })).toEqual({})
		expect(c.postStateToWebview).toHaveBeenCalledTimes(1)
		expect(f.getBanner).not.toHaveBeenCalled()
		expect(f.dismiss).not.toHaveBeenCalled()
	})
	it("ignores stale browser event messages without emitting telemetry", async () => {
		expect(await trackBannerEvent(controller() as any, { bannerId: "old-banner", eventType: "dismiss" })).toEqual({})
		expect(f.getBanner).not.toHaveBeenCalled()
		expect(f.event).not.toHaveBeenCalled()
	})
	it("ignores empty and unsupported legacy messages", async () => {
		const c = controller()
		expect(await dismissBanner(c as any, { value: "" })).toEqual({})
		expect(await trackBannerEvent(c as any, { bannerId: "old", eventType: "unknown" })).toEqual({})
		expect(f.getBanner).not.toHaveBeenCalled()
	})
})


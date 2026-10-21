// AC-QB-016/017: old Cline account state cannot enable hosted services.
// AC-QB-018: direct-provider auth remains independent of Cline accounts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AuthService, LogoutReason } from "./auth-service"

const f = vi.hoisted(() => ({
	clineLogin: vi.fn(),
	refresh: vi.fn(),
	hostedGet: vi.fn(),
	fetch: vi.fn(),
	bannerInit: vi.fn(),
	bannerUpdate: vi.fn(),
	flags: vi.fn(),
	identify: vi.fn(),
	getSettings: vi.fn(),
	saveSettings: vi.fn(),
	register: vi.fn(),
	directLogin: vi.fn(),
	saveCodex: vi.fn(),
	clearCodex: vi.fn(),
	ocaLogin: vi.fn(),
	ocaCallback: vi.fn(),
	oldOcaLogin: vi.fn(),
	open: vi.fn(),
	message: vi.fn(),
	getApi: vi.fn(),
	setApi: vi.fn(),
	settings: new Map<string, any>(),
}))
vi.mock("@cline/core", () => ({
	createOAuthClientCallbacks: (options: any) => options,
	loginClineOAuth: f.clineLogin,
	getValidClineCredentials: f.refresh,
	loginOcaOAuth: f.oldOcaLogin,
	loginOpenAICodex: f.directLogin,
	getProviderAuthStorageId: (provider: string) => (provider === "cline-pass" ? "cline" : provider),
	sdkDebug: vi.fn(),
	hashSecret: () => "redacted",
}))
vi.mock("axios", () => ({ default: { get: f.hostedGet } }))
vi.mock("@/shared/net", () => ({ fetch: f.fetch, getAxiosSettings: () => ({}) }))
vi.mock("@/config", () => ({
	ClineEnv: {
		config: () => ({ environment: "local", apiBaseUrl: "https://api.cline.bot", appBaseUrl: "https://app.cline.bot" }),
	},
}))
vi.mock("@/services/EnvUtils", () => ({ buildBasicClineHeaders: async () => ({}) }))
vi.mock("@/services/banner/BannerService", () => ({ BannerService: { initialize: f.bannerInit, onAuthUpdate: f.bannerUpdate } }))
vi.mock("@/services/feature-flags", () => ({ featureFlagsService: { poll: f.flags } }))
vi.mock("@/services/telemetry", () => ({ telemetryService: { identifyAccount: f.identify, captureAuthLoggedOut: vi.fn() } }))
vi.mock("@/services/auth/oca/OcaAuthService", () => ({
	OcaAuthService: { getInstance: () => ({ createAuthRequest: f.ocaLogin, handleAuthCallback: f.ocaCallback }) },
}))
vi.mock("@/integrations/openai-codex/oauth", () => ({
	openAiCodexOAuthManager: { saveCredentials: f.saveCodex, clearCredentials: f.clearCodex },
}))
vi.mock("@/core/controller/grpc-handler", () => ({ getRequestRegistry: () => ({ registerRequest: f.register }) }))
vi.mock("@/hosts/host-provider", () => ({
	HostProvider: {
		window: { showMessage: f.message },
		get: () => ({ getCallbackUrl: async () => "vscode://sharpninja.cline-qb/auth" }),
	},
}))
vi.mock("@/core/storage/StateManager", () => ({
	StateManager: { get: () => ({ getApiConfiguration: f.getApi, setApiConfiguration: f.setApi, setGlobalState: vi.fn() }) },
}))
vi.mock("./provider-migration", () => ({
	getProviderSettingsManager: () => ({
		getProviderSettings: f.getSettings,
		saveProviderSettings: f.saveSettings,
		read: () => ({ lastUsedProvider: "openai-codex" }),
	}),
}))
vi.mock("@/utils/env", () => ({ openExternal: f.open }))
vi.mock("@/shared/services/Logger", () => ({ Logger: { log: vi.fn(), error: vi.fn(), warn: vi.fn() } }))

let service: AuthService
const credentials = {
	access: "synthetic-direct-access",
	refresh: "synthetic-direct-refresh",
	expires: 1700000000000,
	accountId: "direct-account",
	email: "test@example.invalid",
}
const legacy = {
	provider: "cline",
	auth: {
		accessToken: "workos:synthetic-old-token",
		refreshToken: "synthetic-old-refresh",
		expiresAt: 1,
		metadata: { arbitrary: "preserve" },
	},
}
function injectLegacy() {
	Object.assign(service, {
		_authenticated: true,
		_clineAuthInfo: {
			idToken: "synthetic-stale",
			refreshToken: "synthetic-refresh",
			expiresAt: 1,
			provider: "cline",
			userInfo: { id: "old-user", organizations: [{ active: true, organizationId: "old-org" }] },
		},
	})
}
function noCloud() {
	for (const spy of [f.clineLogin, f.refresh, f.hostedGet, f.bannerInit, f.bannerUpdate, f.flags, f.identify, f.oldOcaLogin])
		expect(spy).not.toHaveBeenCalled()
}
beforeEach(() => {
	vi.resetAllMocks()
	;(AuthService as any).instance = null
	f.settings.clear()
	f.settings.set("cline", structuredClone(legacy))
	f.getSettings.mockImplementation((provider: string) => f.settings.get(provider))
	f.saveSettings.mockImplementation((settings: any) => f.settings.set(settings.provider, structuredClone(settings)))
	f.clineLogin.mockRejectedValue(new Error("Hosted login intercepted"))
	f.refresh.mockResolvedValue(null)
	f.hostedGet.mockResolvedValue({ data: { data: { id: "old-user", organizations: [] } } })
	f.bannerUpdate.mockResolvedValue(undefined)
	f.directLogin.mockResolvedValue(credentials)
	f.oldOcaLogin.mockResolvedValue(credentials)
	f.saveCodex.mockResolvedValue(undefined)
	f.clearCodex.mockResolvedValue(undefined)
	f.ocaLogin.mockResolvedValue({ value: "direct-oca-url" })
	f.ocaCallback.mockResolvedValue(undefined)
	f.getApi.mockReturnValue({ planModeApiProvider: "anthropic", actModeApiProvider: "anthropic", other: "preserved" })
	service = AuthService.getInstance()
})
afterEach(() => vi.unstubAllEnvs())

describe("Cline account exclusion", () => {
	it("keeps singleton construction local even with a controller", () => {
		expect(AuthService.getInstance({} as any)).toBe(service)
		noCloud()
	})
	for (const seeded of [false, true]) {
		it("never exposes a hosted identity or token, legacy=" + seeded, async () => {
			if (seeded) injectLegacy()
			expect(service.getInfo().user).toBeUndefined()
			expect(service.getActiveOrganizationId()).toBeNull()
			expect(service.getUserOrganizations()).toBeUndefined()
			expect(service.getProviderName()).toBeNull()
			expect(await service.getAuthToken()).toBeNull()
			noCloud()
		})
		it("restore/replay/sign-out preserve stored credentials, legacy=" + seeded, async () => {
			if (seeded) injectLegacy()
			const before = JSON.stringify([...f.settings])
			await service.restoreRefreshTokenAndRetrieveAuthInfo()
			await service.restoreRefreshTokenAndRetrieveAuthInfo()
			await service.handleDeauth(LogoutReason.USER_INITIATED)
			expect(service.getInfo().user).toBeUndefined()
			expect(JSON.stringify([...f.settings])).toBe(before)
			expect(f.getSettings).not.toHaveBeenCalled()
			expect(f.saveSettings).not.toHaveBeenCalled()
			noCloud()
		})
	}
	for (const strict of [false, true])
		for (const e2e of ["false", "true"]) {
			it("rejects hosted sign-in before browser or mock login, strict=" + strict + ", E2E=" + e2e, async () => {
				vi.stubEnv("E2E_TEST", e2e)
				injectLegacy()
				await expect(service.createAuthRequest(strict)).rejects.toMatchObject({ code: "cline_account_disabled" })
				expect(f.open).not.toHaveBeenCalled()
				expect(f.fetch).not.toHaveBeenCalled()
				expect(f.saveSettings).not.toHaveBeenCalled()
				noCloud()
			})
		}
	for (const code of ["old-callback", "", "malformed?code=foo"]) {
		it("rejects stale/native hosted callbacks: " + code, async () => {
			await expect(service.handleAuthCallback(code, "workos")).rejects.toMatchObject({ code: "cline_account_disabled" })
			expect(f.fetch).not.toHaveBeenCalled()
			expect(f.saveSettings).not.toHaveBeenCalled()
			noCloud()
		})
	}
	it("pushes local signed-out state immediately and once per controller", async () => {
		injectLegacy()
		const controller = { postStateToWebview: vi.fn(), invalidateProviderListings: vi.fn() }
		const a = vi.fn(),
			b = vi.fn()
		await service.subscribeToAuthStatusUpdate(controller as any, {}, a, "request-a")
		expect(a).toHaveBeenCalledWith({ user: undefined }, false)
		await service.subscribeToAuthStatusUpdate(controller as any, {}, b, "request-b")
		controller.postStateToWebview.mockClear()
		await service.sendAuthStatusUpdate()
		expect(controller.postStateToWebview).toHaveBeenCalledTimes(1)
		expect(b).toHaveBeenCalledWith({ user: undefined }, false)
		noCloud()
	})
	it("honors request cleanup without delivering later updates", async () => {
		const stream = vi.fn()
		await service.subscribeToAuthStatusUpdate(
			{ postStateToWebview: vi.fn(), invalidateProviderListings: vi.fn() } as any,
			{},
			stream,
			"cleanup",
		)
		expect(f.register).toHaveBeenCalledWith(
			"cleanup",
			expect.any(Function),
			{ type: "authStatusUpdate_subscription" },
			stream,
		)
		f.register.mock.calls[0][1]()
		stream.mockClear()
		await service.sendAuthStatusUpdate()
		expect(stream).not.toHaveBeenCalled()
		noCloud()
	})
	it("removes a failed subscriber while delivering to healthy subscribers", async () => {
		const ctrl = { postStateToWebview: vi.fn(), invalidateProviderListings: vi.fn() }
		const failed = vi.fn().mockRejectedValue(new Error("disconnected")),
			healthy = vi.fn()
		await service.subscribeToAuthStatusUpdate(ctrl as any, {}, failed)
		await service.subscribeToAuthStatusUpdate(ctrl as any, {}, healthy)
		await service.sendAuthStatusUpdate()
		expect(failed).toHaveBeenCalledTimes(1)
		expect(healthy).toHaveBeenCalledTimes(2)
		noCloud()
	})
})

describe("permitted direct-provider authentication", () => {
	it("saves OpenAI credentials without a Cline profile, flags or account", async () => {
		await service.openAiCodexLogin()
		expect(f.directLogin).toHaveBeenCalledTimes(1)
		expect(f.settings.get("openai-codex").auth.accessToken).toBe(credentials.access)
		expect(f.saveCodex).toHaveBeenCalledWith(
			expect.objectContaining({ type: "openai-codex", access_token: credentials.access }),
		)
		expect(f.settings.get("cline")).toEqual(legacy)
		expect(service.getInfo().user).toBeUndefined()
		noCloud()
	})
	it("surfaces direct sign-in failure without account fallback", async () => {
		f.directLogin.mockRejectedValue(new Error("Direct credential rejected"))
		await expect(service.openAiCodexLogin()).rejects.toThrow("Direct credential rejected")
		expect(f.saveSettings).not.toHaveBeenCalled()
		noCloud()
	})
	it("surfaces credential persistence failure without claiming successful sign-in", async () => {
		f.saveSettings.mockImplementation(() => {
			throw new Error("Local credential storage denied")
		})
		await expect(service.openAiCodexLogin()).rejects.toThrow("Local credential storage denied")
		expect(f.saveCodex).not.toHaveBeenCalled()
		noCloud()
	})
	it("clears only the requested direct provider", async () => {
		f.settings.set("openai-codex", { provider: "openai-codex", auth: { accessToken: "synthetic" } })
		await service.clearCodexCredentials()
		expect(f.settings.get("openai-codex").auth).toBeUndefined()
		expect(f.settings.get("cline")).toEqual(legacy)
		noCloud()
	})
	it("routes OCA sign-in and callback to the separate provider service", async () => {
		expect(await service.ocaLogin()).toEqual({ value: "direct-oca-url" })
		await service.handleOcaAuthCallback("direct-code", "direct-state")
		expect(f.ocaCallback).toHaveBeenCalledWith("direct-code", "direct-state")
		expect(f.saveSettings).not.toHaveBeenCalled()
		noCloud()
	})
	it("exchanges OpenRouter code only with the direct provider", async () => {
		f.fetch.mockResolvedValue({ ok: true, json: async () => ({ key: "synthetic-direct-key" }) })
		await service.handleOpenRouterCallback("direct-code")
		expect(f.fetch).toHaveBeenCalledWith(
			"https://openrouter.ai/api/v1/auth/keys",
			expect.objectContaining({ method: "POST", body: JSON.stringify({ code: "direct-code" }) }),
		)
		expect(f.setApi).toHaveBeenCalledWith(
			expect.objectContaining({
				other: "preserved",
				planModeApiProvider: "openrouter",
				actModeApiProvider: "openrouter",
				openRouterApiKey: "synthetic-direct-key",
			}),
		)
		noCloud()
	})
	for (const response of [
		{ ok: false, status: 401 },
		{ ok: true, json: async () => ({}) },
	]) {
		it("does not switch providers on invalid OpenRouter response, ok=" + response.ok, async () => {
			f.fetch.mockResolvedValue(response)
			await expect(service.handleOpenRouterCallback("invalid-code")).rejects.toThrow()
			expect(f.setApi).not.toHaveBeenCalled()
			noCloud()
		})
	}
	for (const [method, provider, field] of [
		["handleRequestyCallback", "requesty", "requestyApiKey"],
		["handleHicapCallback", "hicap", "hicapApiKey"],
	] as const) {
		it("retains direct " + provider + " callback", async () => {
			await service[method]("synthetic-direct-key")
			expect(f.setApi).toHaveBeenCalledWith(
				expect.objectContaining({
					[field]: "synthetic-direct-key",
					planModeApiProvider: provider,
					actModeApiProvider: provider,
				}),
			)
			expect(f.fetch).not.toHaveBeenCalled()
			noCloud()
		})
	}
})

// Cline account compatibility surface for the private product. Hosted identity
// is always absent; direct-provider OAuth retains its own credential stores.
import type { ITelemetryService, OAuthCredentials } from "@cline/core"
import { createOAuthClientCallbacks, loginOpenAICodex } from "@cline/core"
import type { ApiProvider } from "@shared/api"
import { AuthState } from "@shared/proto/cline/account"
import type { EmptyRequest, String } from "@shared/proto/cline/common"
import { ShowMessageType } from "@shared/proto/host/window"
import type { Controller } from "@/core/controller"
import { getRequestRegistry, type StreamingResponseHandler } from "@/core/controller/grpc-handler"
import { StateManager } from "@/core/storage/StateManager"
import { HostProvider } from "@/hosts/host-provider"
import { openAiCodexOAuthManager } from "@/integrations/openai-codex/oauth"
import { OcaAuthService } from "@/services/auth/oca/OcaAuthService"
import { LogoutReason } from "@/services/auth/types"
import { fetch } from "@/shared/net"
import { Logger } from "@/shared/services/Logger"
import { openExternal } from "@/utils/env"
import { getProviderSettingsManager } from "./provider-migration"

export interface ClineAuthInfo {
	idToken: string
	refreshToken?: string
	expiresAt?: number // seconds since epoch
	userInfo: ClineAccountUserInfo
	provider: string
	startedAt?: number
}

export interface ClineAccountUserInfo {
	createdAt?: string
	displayName: string
	email: string
	id: string
	organizations: ClineAccountOrganization[]
	appBaseUrl?: string
	subject?: string
}

export interface ClineAccountOrganization {
	active: boolean
	memberId: string
	name: string
	organizationId: string
	roles: string[]
}

// Single source for the logout-reason vocabulary; re-exported here so SDK-side
// callers (SdkController, extension.ts) keep importing it from this module.
export { LogoutReason }

function accountUnavailable(): Error & { code: string } {
	return Object.assign(new Error("Cline account sign-in is disabled. Configure a direct provider in Settings."), {
		code: "cline_account_disabled",
	})
}

export class AuthService {
	private static instance: AuthService | null = null
	private _activeAuthStatusUpdateHandlers = new Set<StreamingResponseHandler<AuthState>>()
	private _handlerToController = new Map<StreamingResponseHandler<AuthState>, Controller>()
	private constructor() {}

	public static getInstance(_controller?: Controller, _telemetry?: ITelemetryService): AuthService {
		AuthService.instance ??= new AuthService()
		return AuthService.instance
	}

	set controller(_controller: Controller) {}
	async getAuthToken(): Promise<string | null> {
		return null
	}
	getActiveOrganizationId(): string | null {
		return null
	}
	getUserOrganizations(): ClineAccountOrganization[] | undefined {
		return undefined
	}
	getProviderName(): string | null {
		return null
	}
	getInfo(): AuthState {
		return AuthState.create({})
	}

	async createAuthRequest(_strict = false): Promise<String> {
		throw accountUnavailable()
	}
	async handleAuthCallback(_authorizationCode: string, _provider: string): Promise<void> {
		throw accountUnavailable()
	}

	// Legacy credentials remain untouched. Restore/logout only publish local state.
	async restoreRefreshTokenAndRetrieveAuthInfo(): Promise<void> {
		await this.sendAuthStatusUpdate()
	}
	async handleDeauth(_reason: LogoutReason = LogoutReason.UNKNOWN): Promise<void> {
		await this.sendAuthStatusUpdate()
	}

	async ocaLogin(): Promise<String> {
		return OcaAuthService.getInstance().createAuthRequest()
	}
	async handleOcaAuthCallback(code: string, state: string): Promise<void> {
		await OcaAuthService.getInstance().handleAuthCallback(code, state)
	}

	async openAiCodexLogin(): Promise<void> {
		try {
			const callbacks = createOAuthClientCallbacks({
				onPrompt: async (prompt) => prompt.defaultValue ?? "",
				openUrl: async (url: string) => {
					// E2E drives the OAuth callback itself (codex-oauth.test.ts).
					// Opening a real browser on the runner leaves an orphaned
					// process holding the Playwright<->Electron pipes, which
					// wedges the worker teardown until its 60s timeout fails
					// the job.
					if (process.env.E2E_TEST === "true") {
						return
					}
					await openExternal(url)
				},
				onOpenUrlError: ({ url, error }) => {
					// Same recovery the CLI offers ("open the URL above manually") —
					// the toast is the extension's only place to surface the URL.
					Logger.error(`[SdkAuthService] Failed to open browser for Codex: ${url}:`, error)
					HostProvider.window.showMessage({
						type: ShowMessageType.ERROR,
						message: `Couldn't open your browser for OpenAI sign-in. Open this URL manually: ${url}`,
					})
				},
			})

			const credentials = await loginOpenAICodex(callbacks)

			// Store Codex credentials in providers.json
			await this.saveCodexCredentials(credentials)
			await openAiCodexOAuthManager.saveCredentials({
				type: "openai-codex",
				access_token: credentials.access,
				refresh_token: credentials.refresh,
				expires: credentials.expires,
				email: credentials.email,
				accountId: credentials.accountId,
			})

			// Notify webview of state change
			await this.sendAuthStatusUpdate()
		} catch (error) {
			Logger.error("[SdkAuthService] OpenAI Codex OAuth login failed:", error)
			throw error
		}
	}

	/**
	 * Save Codex OAuth credentials to provider settings.
	 */
	private async saveCodexCredentials(credentials: OAuthCredentials): Promise<void> {
		try {
			const manager = getProviderSettingsManager()
			const existing = manager.getProviderSettings("openai-codex")

			manager.saveProviderSettings(
				{
					...(existing ?? { provider: "openai-codex" }),
					provider: "openai-codex",
					auth: {
						accessToken: credentials.access,
						refreshToken: credentials.refresh,
						accountId: credentials.accountId,
					},
				},
				{ tokenSource: "oauth" },
			)
		} catch (error) {
			Logger.error("[SdkAuthService] Failed to save Codex credentials:", error)
			throw error
		}
	}

	/**
	 * Clear Codex credentials from provider settings.
	 */
	async clearCodexCredentials(): Promise<void> {
		try {
			await openAiCodexOAuthManager.clearCredentials()

			const manager = getProviderSettingsManager()
			const existing = manager.getProviderSettings("openai-codex")
			if (existing) {
				manager.saveProviderSettings(
					{
						...existing,
						provider: "openai-codex",
						auth: undefined,
					},
					{ tokenSource: "manual" },
				)
			}
		} catch (error) {
			Logger.error("[SdkAuthService] Failed to clear Codex credentials:", error)
		}
	}

	async subscribeToAuthStatusUpdate(
		controller: Controller,
		_request: EmptyRequest,
		responseStream: StreamingResponseHandler<AuthState>,
		requestId?: string,
	): Promise<void> {
		this._activeAuthStatusUpdateHandlers.add(responseStream)
		this._handlerToController.set(responseStream, controller)

		const cleanup = () => {
			this._activeAuthStatusUpdateHandlers.delete(responseStream)
			this._handlerToController.delete(responseStream)
		}

		if (requestId) {
			getRequestRegistry().registerRequest(requestId, cleanup, { type: "authStatusUpdate_subscription" }, responseStream)
		}

		// Push initial auth state immediately (prevents race condition)
		try {
			await this.sendAuthStatusUpdate()
		} catch (error) {
			Logger.error("[SdkAuthService] Error sending initial auth status:", error)
			this._activeAuthStatusUpdateHandlers.delete(responseStream)
			this._handlerToController.delete(responseStream)
		}
	}

	/**
	 * Send an authStatusUpdate event to all active subscribers.
	 */
	async sendAuthStatusUpdate(): Promise<void> {
		const authState: AuthState = this.getInfo()
		const uniqueControllers = new Set<Controller>()

		const streamSends = Array.from(this._activeAuthStatusUpdateHandlers).map(async (responseStream) => {
			const controller = this._handlerToController.get(responseStream)
			if (controller) {
				uniqueControllers.add(controller)
			}
			try {
				await responseStream(authState, false)
			} catch (error) {
				Logger.error("[SdkAuthService] Error sending authStatusUpdate event:", error)
				this._activeAuthStatusUpdateHandlers.delete(responseStream)
				this._handlerToController.delete(responseStream)
			}
		})

		await Promise.all(streamSends)

		for (const controller of uniqueControllers) {
			controller.invalidateProviderListings()
		}

		// Update state in webviews once per unique controller
		await Promise.all(Array.from(uniqueControllers).map((c) => c.postStateToWebview()))
	}

	// ---- Provider-specific auth callbacks ----

	/**
	 * Shared helper: set a provider's API key and switch both plan/act modes to it.
	 */
	private setProviderApiKey(provider: ApiProvider, apiKeyField: string, apiKey: string): void {
		const stateManager = StateManager.get()
		const currentApiConfiguration = stateManager.getApiConfiguration()
		const updatedConfig = {
			...currentApiConfiguration,
			planModeApiProvider: provider,
			actModeApiProvider: provider,
			[apiKeyField]: apiKey,
		}
		stateManager.setApiConfiguration(updatedConfig)
	}

	/**
	 * Handle OpenRouter OAuth callback.
	 */
	async handleOpenRouterCallback(code: string): Promise<void> {
		let apiKey: string
		try {
			const response = await fetch("https://openrouter.ai/api/v1/auth/keys", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ code }),
			})
			if (!response.ok) {
				throw new Error(`OpenRouter API responded with status ${response.status}`)
			}
			const data = (await response.json()) as { key?: string }
			if (data?.key) {
				apiKey = data.key
			} else {
				throw new Error("Invalid response from OpenRouter API")
			}
		} catch (error) {
			Logger.error("[SdkAuthService] Error exchanging code for API key:", error)
			throw error
		}

		this.setProviderApiKey("openrouter", "openRouterApiKey", apiKey)
	}

	/**
	 * Handle Requesty OAuth callback.
	 */
	async handleRequestyCallback(code: string): Promise<void> {
		this.setProviderApiKey("requesty", "requestyApiKey", code)
	}

	/**
	 * Handle Hicap OAuth callback.
	 */
	async handleHicapCallback(code: string): Promise<void> {
		this.setProviderApiKey("hicap", "hicapApiKey", code)
	}
}

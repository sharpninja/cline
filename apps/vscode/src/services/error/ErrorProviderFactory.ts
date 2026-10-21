import type { PostHogClientConfig } from "@/shared/services/config/posthog-config"
import { Logger } from "@/shared/services/Logger"
import type { ClineError } from "./ClineError"
import type { IErrorProvider } from "./providers/IErrorProvider"

export interface ErrorProviderConfig {
	type: "posthog" | "no-op"
	config: PostHogClientConfig
}

/** Preserve local error reporting without creating an external client. */
export class ErrorProviderFactory {
	public static async createProvider(_config: ErrorProviderConfig): Promise<IErrorProvider> {
		return new NoOpErrorProvider()
	}

	public static getDefaultConfig(): ErrorProviderConfig {
		return { type: "no-op", config: { host: "", uiHost: "" } }
	}
}

class NoOpErrorProvider implements IErrorProvider {
	async captureException(error: Error | ClineError, properties?: Record<string, unknown>): Promise<void> {
		Logger.error("[NoOpErrorProvider] captureException called", { error: error.message || String(error), properties })
	}

	public logException(error: Error | ClineError, _properties?: Record<string, unknown>): void {
		// Use Logger.error directly to avoid potential infinite recursion through Logger
		Logger.error("[NoOpErrorProvider]", error.message || String(error))
	}

	public logMessage(
		message: string,
		level?: "error" | "warning" | "log" | "debug" | "info",
		properties?: Record<string, unknown>,
	): void {
		Logger.log("[NoOpErrorProvider]", { message, level, properties })
	}

	public isEnabled(): boolean {
		return true
	}

	public getSettings() {
		return {
			enabled: true,
			hostEnabled: true,
			level: "all" as const,
		}
	}

	public async dispose(): Promise<void> {
		Logger.info("[NoOpErrorProvider] Disposing")
	}
}

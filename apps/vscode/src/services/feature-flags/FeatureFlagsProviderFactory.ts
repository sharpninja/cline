import { Logger } from "@/shared/services/Logger"
import type { FeatureFlagsAndPayloads, IFeatureFlagsProvider } from "./providers/IFeatureFlagsProvider"

export interface FeatureFlagsProviderConfig {
	type: "posthog" | "no-op"
}

/** Hosted flags cannot override the local compiled defaults in cline-qb. */
export class FeatureFlagsProviderFactory {
	public static createProvider(_config: FeatureFlagsProviderConfig): IFeatureFlagsProvider {
		return new NoOpFeatureFlagsProvider()
	}

	public static getDefaultConfig(): FeatureFlagsProviderConfig {
		return { type: "no-op" }
	}
}

class NoOpFeatureFlagsProvider implements IFeatureFlagsProvider {
	async getAllFlagsAndPayloads(_: { flagKeys?: string[] }): Promise<FeatureFlagsAndPayloads | undefined> {
		return {}
	}

	public isEnabled(): boolean {
		return true
	}

	public getSettings() {
		return {
			enabled: true,
			timeout: 1000,
		}
	}

	public async dispose(): Promise<void> {
		Logger.info("[NoOpFeatureFlagsProvider] Disposing")
	}
}

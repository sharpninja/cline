import type { RemoteConfigBundle } from "@cline/shared"
import type { RemoteConfig } from "@/shared/remote-config/schema"
import type { ConfiguredAPIKeys } from "@/shared/storage/state-keys"

export interface SdkRemoteConfigControlPlaneController {
	accountService: {
		switchAccount(organizationId: string): Promise<unknown>
		fetchUserRemoteConfig(): Promise<import("@/shared/ClineAccount").UserRemoteConfigDiscoveryResponse | null | undefined>
	}
	stateManager: {
		setSecret(key: "remoteLiteLlmApiKey", value: string | undefined): unknown
		getGlobalStateKey(key: "remoteRulesToggles" | "remoteWorkflowToggles" | "remoteSkillsToggles"): Record<string, boolean>
		getGlobalStateKey(key: "lastManagedOrganizationId"): string | undefined
	}
}

interface RemoteConfigControlPlaneFetchInput {
	workspacePath: string
	rootPath?: string
	context?: unknown
	logger?: unknown
	signal?: AbortSignal
	now?: number
}

export type SdkRemoteConfigBundle = RemoteConfigBundle

/** Compatibility adapter: Cline-hosted configuration cannot supply a bundle. */
export class SdkRemoteConfigControlPlane {
	readonly name = "cline-extension-remote-config"
	constructor(_controller: SdkRemoteConfigControlPlaneController) {}
	getLastConfiguredKeys(): ConfiguredAPIKeys {
		return {}
	}
	getLastRemoteConfig(): RemoteConfig | undefined {
		return undefined
	}
	wasExplicitNoConfig(): boolean {
		return true
	}
	isRemoteConfigAvailable(): boolean {
		return false
	}
	async fetchBundle(_input: RemoteConfigControlPlaneFetchInput): Promise<SdkRemoteConfigBundle | undefined> {
		return undefined
	}
}

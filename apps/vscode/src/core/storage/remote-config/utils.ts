import type { RemoteConfig, S3AccessKeySettings } from "@shared/remote-config/schema"
import { ConfiguredAPIKeys, GlobalStateAndSettings, RemoteConfigFields } from "@shared/storage/state-keys"
import { type McpHub } from "@/services/mcp/McpHub"
import { telemetryService } from "@/services/telemetry"
import { ApiProvider } from "@/shared/api"
import { BlobStoreSettings } from "@/shared/storage"
import { StateManager } from "../StateManager"

function accessSettingsToBlobStorage(type: BlobStoreSettings["adapterType"], settings: S3AccessKeySettings): BlobStoreSettings {
	return {
		adapterType: type,
		accessKeyId: settings.accessKeyId,
		secretAccessKey: settings.secretAccessKey,
		region: settings.region,
		bucket: settings.bucket,
		endpoint: settings.endpoint,
		accountId: settings.accountId,
		intervalMs: settings.intervalMs,
		maxRetries: settings.maxRetries,
		batchSize: settings.batchSize,
		maxQueueSize: settings.maxQueueSize,
		maxFailedAgeMs: settings.maxFailedAgeMs,
		backfillEnabled: settings.backfillEnabled,
	}
}

/**
 * Transforms RemoteConfig schema to RemoteConfigFields shape
 * @param remoteConfig The remote configuration object
 * @returns Partial<RemoteConfigFields> containing only the fields present in remote config
 */
export function transformRemoteConfigToStateShape(remoteConfig: RemoteConfig): Partial<RemoteConfigFields> {
	const transformed: Partial<RemoteConfigFields> = {}

	// Map top-level settings
	if (remoteConfig.telemetryEnabled !== undefined) {
		transformed.telemetrySetting = remoteConfig.telemetryEnabled ? "enabled" : "disabled"
	}
	if (remoteConfig.mcpMarketplaceEnabled !== undefined) {
		transformed.mcpMarketplaceEnabled = remoteConfig.mcpMarketplaceEnabled
	}
	if (remoteConfig.allowedMCPServers !== undefined) {
		transformed.allowedMCPServers = remoteConfig.allowedMCPServers
	}
	if (remoteConfig.blockPersonalRemoteMCPServers !== undefined) {
		transformed.blockPersonalRemoteMCPServers = remoteConfig.blockPersonalRemoteMCPServers
	}
	if (remoteConfig.remoteMCPServers !== undefined) {
		transformed.remoteMCPServers = remoteConfig.remoteMCPServers
	}
	// Map OpenTelemetry settings
	if (remoteConfig.openTelemetryEnabled !== undefined) {
		transformed.openTelemetryEnabled = remoteConfig.openTelemetryEnabled
	}
	if (remoteConfig.openTelemetryMetricsExporter !== undefined) {
		transformed.openTelemetryMetricsExporter = remoteConfig.openTelemetryMetricsExporter
	}
	if (remoteConfig.openTelemetryTracesExporter !== undefined) {
		transformed.openTelemetryTracesExporter = remoteConfig.openTelemetryTracesExporter
	}
	if (remoteConfig.openTelemetryLogsExporter !== undefined) {
		transformed.openTelemetryLogsExporter = remoteConfig.openTelemetryLogsExporter
	}
	if (remoteConfig.openTelemetryOtlpProtocol !== undefined) {
		transformed.openTelemetryOtlpProtocol = remoteConfig.openTelemetryOtlpProtocol
	}
	if (remoteConfig.openTelemetryOtlpEndpoint !== undefined) {
		transformed.openTelemetryOtlpEndpoint = remoteConfig.openTelemetryOtlpEndpoint
	}
	if (remoteConfig.openTelemetryOtlpMetricsProtocol !== undefined) {
		transformed.openTelemetryOtlpMetricsProtocol = remoteConfig.openTelemetryOtlpMetricsProtocol
	}
	if (remoteConfig.openTelemetryOtlpMetricsEndpoint !== undefined) {
		transformed.openTelemetryOtlpMetricsEndpoint = remoteConfig.openTelemetryOtlpMetricsEndpoint
	}
	if (remoteConfig.openTelemetryOtlpLogsProtocol !== undefined) {
		transformed.openTelemetryOtlpLogsProtocol = remoteConfig.openTelemetryOtlpLogsProtocol
	}
	if (remoteConfig.openTelemetryOtlpLogsEndpoint !== undefined) {
		transformed.openTelemetryOtlpLogsEndpoint = remoteConfig.openTelemetryOtlpLogsEndpoint
	}
	if (remoteConfig.openTelemetryMetricExportInterval !== undefined) {
		transformed.openTelemetryMetricExportInterval = remoteConfig.openTelemetryMetricExportInterval
	}
	if (remoteConfig.openTelemetryOtlpInsecure !== undefined) {
		transformed.openTelemetryOtlpInsecure = remoteConfig.openTelemetryOtlpInsecure
	}
	if (remoteConfig.openTelemetryLogBatchSize !== undefined) {
		transformed.openTelemetryLogBatchSize = remoteConfig.openTelemetryLogBatchSize
	}
	if (remoteConfig.openTelemetryLogBatchTimeout !== undefined) {
		transformed.openTelemetryLogBatchTimeout = remoteConfig.openTelemetryLogBatchTimeout
	}
	if (remoteConfig.openTelemetryLogMaxQueueSize !== undefined) {
		transformed.openTelemetryLogMaxQueueSize = remoteConfig.openTelemetryLogMaxQueueSize
	}
	if (remoteConfig.openTelemetryOtlpHeaders !== undefined) {
		transformed.openTelemetryOtlpHeaders = remoteConfig.openTelemetryOtlpHeaders
	}
	if (remoteConfig.openTelemetryOtlpMetricsHeaders !== undefined) {
		transformed.otlpMetricsHeaders = remoteConfig.openTelemetryOtlpMetricsHeaders
	}
	if (remoteConfig.openTelemetryOtlpLogsHeaders !== undefined) {
		transformed.otlpLogsHeaders = remoteConfig.openTelemetryOtlpLogsHeaders
	}

	// Map provider settings
	const providers: ApiProvider[] = []

	// Map OpenAiCompatible provider settings
	const openAiSettings = remoteConfig.providerSettings?.OpenAiCompatible
	if (openAiSettings) {
		transformed.planModeApiProvider = "openai"
		transformed.actModeApiProvider = "openai"
		providers.push("openai")

		if (openAiSettings.openAiBaseUrl !== undefined) {
			transformed.openAiBaseUrl = openAiSettings.openAiBaseUrl
		}
		if (openAiSettings.openAiHeaders !== undefined) {
			transformed.openAiHeaders = openAiSettings.openAiHeaders
		}
		if (openAiSettings.azureApiVersion !== undefined) {
			transformed.azureApiVersion = openAiSettings.azureApiVersion
		}
		if (openAiSettings.azureIdentity !== undefined) {
			transformed.azureIdentity = openAiSettings.azureIdentity
		}
	}

	// Map AwsBedrock provider settings
	const awsBedrockSettings = remoteConfig.providerSettings?.AwsBedrock
	if (awsBedrockSettings) {
		transformed.planModeApiProvider = "bedrock"
		transformed.actModeApiProvider = "bedrock"
		providers.push("bedrock")

		if (awsBedrockSettings.awsRegion !== undefined) {
			transformed.awsRegion = awsBedrockSettings.awsRegion
		}
		if (awsBedrockSettings.awsUseCrossRegionInference !== undefined) {
			transformed.awsUseCrossRegionInference = awsBedrockSettings.awsUseCrossRegionInference
		}
		if (awsBedrockSettings.awsUseGlobalInference !== undefined) {
			transformed.awsUseGlobalInference = awsBedrockSettings.awsUseGlobalInference
		}
		if (awsBedrockSettings.awsBedrockUsePromptCache !== undefined) {
			transformed.awsBedrockUsePromptCache = awsBedrockSettings.awsBedrockUsePromptCache
		}
		if (awsBedrockSettings.awsBedrockEndpoint !== undefined) {
			transformed.awsBedrockEndpoint = awsBedrockSettings.awsBedrockEndpoint
		}
	}

	const clineSettings = remoteConfig.providerSettings?.Cline
	if (clineSettings) {
		transformed.planModeApiProvider = "cline"
		transformed.actModeApiProvider = "cline"
		providers.push("cline")
	}

	// Map LiteLLM provider settings
	const liteLlmSettings = remoteConfig.providerSettings?.LiteLLM
	if (liteLlmSettings) {
		transformed.planModeApiProvider = "litellm"
		transformed.actModeApiProvider = "litellm"
		providers.push("litellm")

		if (liteLlmSettings.baseUrl !== undefined) {
			transformed.liteLlmBaseUrl = liteLlmSettings.baseUrl
		}
	}

	// Map Vertex provider settings
	const vertexSettings = remoteConfig.providerSettings?.Vertex
	if (vertexSettings) {
		transformed.planModeApiProvider = "vertex"
		transformed.actModeApiProvider = "vertex"
		providers.push("vertex")

		if (vertexSettings.vertexProjectId !== undefined) {
			transformed.vertexProjectId = vertexSettings.vertexProjectId
		}
		if (vertexSettings.vertexRegion !== undefined) {
			transformed.vertexRegion = vertexSettings.vertexRegion
		}
	}

	const anthropicSettings = remoteConfig.providerSettings?.Anthropic
	if (anthropicSettings) {
		transformed.planModeApiProvider = "anthropic"
		transformed.actModeApiProvider = "anthropic"
		providers.push("anthropic")

		if (anthropicSettings.baseUrl) {
			transformed.anthropicBaseUrl = anthropicSettings.baseUrl
		}
	}

	// This line needs to stay here, it is order dependent on the above code checking the configured providers
	if (providers.length > 0) {
		transformed.remoteConfiguredProviders = providers
	}

	// Map global rules, workflows, and skills
	if (remoteConfig.globalRules !== undefined) {
		transformed.remoteGlobalRules = remoteConfig.globalRules
	}
	if (remoteConfig.globalWorkflows !== undefined) {
		transformed.remoteGlobalWorkflows = remoteConfig.globalWorkflows
	}
	if (remoteConfig.globalSkills !== undefined) {
		transformed.remoteGlobalSkills = remoteConfig.globalSkills
	}

	if (remoteConfig.enterpriseTelemetry?.promptUploading) {
		const promptUplaoding = remoteConfig.enterpriseTelemetry.promptUploading
		if (promptUplaoding.type === "s3_access_keys" && promptUplaoding.s3AccessSettings) {
			transformed.blobStoreConfig = accessSettingsToBlobStorage("s3", promptUplaoding.s3AccessSettings)
		} else if (promptUplaoding.type === "r2_access_keys" && promptUplaoding.r2AccessSettings) {
			transformed.blobStoreConfig = accessSettingsToBlobStorage("r2", promptUplaoding.r2AccessSettings)
		} else if (promptUplaoding.type === "azure_access_keys" && promptUplaoding.azureAccessSettings) {
			transformed.blobStoreConfig = accessSettingsToBlobStorage("azure", promptUplaoding.azureAccessSettings)
		}
	}

	return transformed
}

export const REMOTE_CONFIG_OTEL_PROVIDER_ID = "OpenTelemetryRemoteConfiguredProvider"

/** Clear runtime-only state; excluded legacy files and credentials stay untouched. */
export async function clearRemoteConfig(_organizationId?: string): Promise<void> {
	StateManager.get().clearRemoteConfig()
	await telemetryService.removeProvider(REMOTE_CONFIG_OTEL_PROVIDER_ID)
}

/** Legacy callers cannot publish hosted policy, credentials, MCP servers or uploads. */
export async function applyRemoteConfig(
	_remoteConfig: RemoteConfig,
	_configuredKeys: ConfiguredAPIKeys,
	_mcpHub: McpHub,
): Promise<void> {
	await clearRemoteConfig()
}

const isProviderValid = (provider?: ApiProvider, remoteConfig?: Partial<RemoteConfigFields>) => {
	const remoteConfiguredProviders =
		remoteConfig?.remoteConfiguredProviders ?? StateManager.get().getRemoteConfigSettings().remoteConfiguredProviders
	if (!remoteConfiguredProviders || !remoteConfiguredProviders.length) {
		return true
	}

	return provider && remoteConfiguredProviders.includes(provider)
}

/**
 * Receives a config and returns the subset of fields that can be overriden in the cache
 */
export function filterAllowedRemoteConfigFields(config: Partial<GlobalStateAndSettings>): Partial<GlobalStateAndSettings> {
	const updatedFields: Partial<GlobalStateAndSettings> = {}

	const actModeApiProvider = config.actModeApiProvider
	if (isProviderValid(actModeApiProvider)) {
		updatedFields.actModeApiProvider = actModeApiProvider
	}

	const planModeApiProvider = config.planModeApiProvider
	if (isProviderValid(planModeApiProvider)) {
		updatedFields.planModeApiProvider = planModeApiProvider
	}

	return updatedFields
}

export const isRemoteConfigEnabled = (_orgId: string): boolean => false

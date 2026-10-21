import type { ProviderSettingsManager } from "@cline/core";
import type { BasicLogger, ITelemetryService } from "@cline/shared";
import { rejectClineAccount } from "@cline/qbrain-governance/cloud-policy";

export type ClineAuthTelemetryContext = {
	logger?: BasicLogger;
	telemetry?: ITelemetryService;
};
export type ConnectorsApiAuth = {
	accountId: string;
	baseUrl: string;
	token: string;
};

/** Desktop never opens or refreshes upstream account credentials, including fallback. */
export async function resolveFreshClineAuthToken(
	_manager: ProviderSettingsManager,
	_ctx: ClineAuthTelemetryContext = {},
): Promise<string | undefined> {
	return rejectClineAccount();
}
export function getClineAccountId(): string | undefined {
	return rejectClineAccount();
}
export function getClineApiBaseUrl(): string {
	return rejectClineAccount();
}
export async function resolveConnectorsApiAuth(
	_ctx: ClineAuthTelemetryContext = {},
): Promise<ConnectorsApiAuth | undefined> {
	return rejectClineAccount();
}

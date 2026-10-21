import { rejectClineAccount } from "@cline/qbrain-governance/cloud-policy";
import type {
	ClineGitHubRepository,
	ClineIntegration,
} from "../webview/lib/cline-integrations-types";

export interface ClineIntegrationsRequestOptions {
	apiBaseUrl: string;
	appBaseUrl: string;
	authToken: string;
	requestTimeoutMs?: number;
	fetchImpl?: typeof fetch;
}

// Refuse even explicit calls with cached credentials or alternate Cline endpoints.
export async function listClineIntegrations(
	_options: ClineIntegrationsRequestOptions,
): Promise<ClineIntegration[]> {
	return rejectClineAccount();
}
export async function listClineGitHubRepositories(
	_options: ClineIntegrationsRequestOptions,
): Promise<ClineGitHubRepository[]> {
	return rejectClineAccount();
}
export async function resolveGitHubInstallUrl(
	_options: ClineIntegrationsRequestOptions,
): Promise<{ url: string }> {
	return rejectClineAccount();
}

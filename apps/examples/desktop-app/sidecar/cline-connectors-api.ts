import type { BasicLogger } from "@cline/shared";
import type { ComposioToolkitSlug } from "../webview/lib/composio-types";
import type { ClineAuthTelemetryContext } from "./cline-auth";

export type ConnectorsRequestContext = ClineAuthTelemetryContext & {
	accountId?: string;
};
export class ConnectorsApiError extends Error {
	readonly status?: number;
	constructor(message: string, status?: number) {
		super(message);
		this.name = "ConnectorsApiError";
		this.status = status;
	}
}
export type ConnectorCatalogEntry = {
	slug: string;
	name: string;
	description?: string;
	logo?: string;
	categories?: string[];
	toolsCount?: number;
};
export type ConnectorConnection = {
	id: string;
	toolkit: { slug: string };
	status: string;
	is_disabled?: boolean;
};
export type ConnectorInitiateResult = {
	connectedAccountId: string;
	redirectUrl?: string;
};
export type ConnectorToolSchema = {
	slug: string;
	name?: string;
	description?: string;
	version?: string;
	input_parameters?: unknown;
};

/** Refuse before resolving credentials, starting a waiter, or making a request. */
export function rejectClineConnectors(): never {
	throw new ConnectorsApiError(
		"Cline connectors are unavailable in cline-qb. Configure user-controlled tools explicitly.",
		403,
	);
}
export async function fetchConnectableToolkits(
	_ctx?: ConnectorsRequestContext,
): Promise<ConnectorCatalogEntry[]> {
	return rejectClineConnectors();
}
export async function initiateConnection(
	_toolkit: ComposioToolkitSlug,
	_ctx?: ConnectorsRequestContext,
): Promise<ConnectorInitiateResult> {
	return rejectClineConnectors();
}
export async function listConnections(
	_ctx?: ConnectorsRequestContext,
): Promise<ConnectorConnection[]> {
	return rejectClineConnectors();
}
export async function deleteConnection(
	_connectedAccountId: string,
	_ctx?: ConnectorsRequestContext,
): Promise<void> {
	return rejectClineConnectors();
}
export async function listToolkitTools(
	_toolkit: ComposioToolkitSlug,
	_ctx?: ConnectorsRequestContext,
): Promise<ConnectorToolSchema[]> {
	return rejectClineConnectors();
}
export async function waitForConnectionActive(
	_connectedAccountId: string,
	_options: {
		timeoutMs: number;
		pollIntervalMs?: number;
		shouldContinue?: () => boolean;
		logger?: BasicLogger;
		ctx?: ConnectorsRequestContext;
	},
): Promise<void> {
	return rejectClineConnectors();
}

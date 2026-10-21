import type { BasicLogger } from "@cline/shared";
import {
	type ComposioCatalogResponse,
	type ComposioConnectResponse,
	type ComposioStatusResponse,
	type ComposioToolkitSlug,
	isComposioToolkitSlug,
} from "../webview/lib/composio-types";
import type { ClineAuthTelemetryContext } from "./cline-auth";
import { rejectClineConnectors } from "./cline-connectors-api";

// Keep the host API compatible without loading saved Cline connector state.
export function __resetComposioCachesForTesting(): void {}
export function parseComposioToolkitSlug(value: unknown): ComposioToolkitSlug {
	const slug = String(value ?? "")
		.trim()
		.toLowerCase();
	if (!isComposioToolkitSlug(slug))
		throw new Error("Invalid Composio toolkit slug: " + String(value));
	return slug;
}
export async function getComposioStatus(_options?: {
	refresh?: boolean;
	logger?: BasicLogger;
	telemetry?: ClineAuthTelemetryContext["telemetry"];
}): Promise<ComposioStatusResponse> {
	return { configured: false, integrations: [] };
}
export async function listComposioToolkits(
	_logger?: BasicLogger,
): Promise<ComposioCatalogResponse> {
	return { configured: false, toolkits: [] };
}
export async function connectComposioToolkit(
	_toolkit: ComposioToolkitSlug,
	_logger?: BasicLogger,
	_options?: { owner?: object },
): Promise<ComposioConnectResponse> {
	return rejectClineConnectors();
}
export async function disconnectComposioToolkit(
	_toolkit: ComposioToolkitSlug,
	_logger?: BasicLogger,
): Promise<ComposioStatusResponse> {
	return rejectClineConnectors();
}
// No attempts can start. Teardown must not revive remote cleanup from old state.
export function abandonComposioConnectsForOwner(
	_owner: object,
	_logger?: BasicLogger,
): number {
	return 0;
}
export async function cancelComposioConnect(
	_toolkit: ComposioToolkitSlug,
	_logger?: BasicLogger,
): Promise<void> {}

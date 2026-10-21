import { rejectClineAccount } from "@cline/qbrain-governance/cloud-policy";
import type { ChatSessionConfig } from "@/lib/chat-schema";
import {
	type ExecutionTarget,
	readModelSelectionStorageFromWindow,
} from "@/lib/model-selection";
import { normalizeProviderId } from "@/lib/provider-id";
import {
	LOCAL_WORKSPACE_ENVIRONMENT_ID,
	readWorkspaceSelectionFromWindow,
} from "@/lib/workspace-paths";

export const CHAT_TRANSPORT_UNAVAILABLE_MESSAGE =
	"Chat connection is unavailable. Reopen the app window to restore realtime chat.";
export const CHAT_WS_ENDPOINT_RETRY_ATTEMPTS = 60;
export const CHAT_WS_ENDPOINT_RETRY_DELAY_MS = 100;
export const CHAT_WS_RECONNECT_BASE_DELAY_MS = 300;
export const CHAT_WS_RECONNECT_MAX_DELAY_MS = 3000;
export const CHAT_WS_REQUEST_TIMEOUT_MS = 120000;
export { OAUTH_PROVIDER_IDS as OAUTH_MANAGED_PROVIDERS } from "@/lib/provider-connection";

export const DEFAULT_CHAT_CONFIG: ChatSessionConfig = {
	sessionId: undefined,
	executionTarget: "local",
	repoUrl: undefined,
	workspaceRoot: "",
	cwd: "",
	environmentId: LOCAL_WORKSPACE_ENVIRONMENT_ID,
	provider: "",
	model: "",
	apiKey: "",
	mode: "act",
	systemPrompt: undefined,
	maxIterations: undefined,
	thinking: undefined,
	reasoningEffort: undefined,
	enableTools: true,
	autoApproveTools: true,
	missionStepInterval: undefined,
	missionTimeIntervalMs: undefined,
};

export function getInitialChatConfig(
	environmentId: string = LOCAL_WORKSPACE_ENVIRONMENT_ID,
	options?: { executionTarget?: ExecutionTarget },
): ChatSessionConfig {
	if (options?.executionTarget === "cloud") return rejectClineAccount();
	const selection = readModelSelectionStorageFromWindow();
	const workspace = readWorkspaceSelectionFromWindow(environmentId);
	const provider = normalizeProviderId(selection.lastProvider);
	return {
		...DEFAULT_CHAT_CONFIG,
		environmentId,
		provider,
		model: provider
			? (selection.lastModelByProvider[provider] ??
				selection.lastModelByProvider[selection.lastProvider.trim()] ??
				"")
			: "",
		workspaceRoot: workspace.lastWorkspace,
		cwd: workspace.lastWorkspace,
	};
}

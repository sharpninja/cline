// SPDX-License-Identifier: Apache-2.0
import { isClineCloudProvider } from "@cline/qbrain-governance/cloud-policy";
import type { ChatSessionConfig } from "./chat-schema";
export type LocalRecoverySelection = Pick<
	ChatSessionConfig,
	"provider" | "model" | "apiKey" | "providerAuth" | "cwd" | "workspaceRoot"
>;
export function recoverLocalDesktopConfig(
	previous: ChatSessionConfig,
	local: LocalRecoverySelection,
): ChatSessionConfig {
	const provider = local.provider.trim();
	const permitted = provider.length > 0 && !isClineCloudProvider(provider);
	const providerAuth =
		permitted && local.providerAuth?.providerId === provider
			? local.providerAuth
			: undefined;
	const wasCloud = previous.executionTarget === "cloud";
	return {
		...previous,
		provider: permitted ? provider : "",
		model: permitted ? local.model : "",
		apiKey: permitted ? local.apiKey : "",
		providerAuth,
		workspaceRoot:
			local.workspaceRoot || (wasCloud ? "" : previous.workspaceRoot),
		cwd: local.cwd || (wasCloud ? "" : previous.cwd),
		sessionId: wasCloud ? undefined : previous.sessionId,
		executionTarget: "local",
		repoUrl: undefined,
		branch: undefined,
	};
}

/** The page supplies effects; blocked or historical targets never mutate config. */
export function applyDesktopExecutionSelection(options: {
	target: "local" | "cloud";
	hasHostedSession: boolean;
	environmentChanged?: boolean;
	persistLocal: () => void;
	changeToLocal: () => void;
	startNewSession?: () => void;
	reportBlocked: (message: string) => void;
}): void {
	if (options.target === "cloud") {
		options.reportBlocked(
			"Cloud is unavailable. Choose Local or a self-controlled SSH host and configure a direct provider in Settings.",
		);
		return;
	}
	if (options.environmentChanged) {
		options.persistLocal();
		return;
	}
	if (options.hasHostedSession) {
		if (!options.startNewSession) {
			options.reportBlocked(
				"Hosted history cannot resume locally. Open a new session with a direct provider.",
			);
			return;
		}
		options.persistLocal();
		options.startNewSession();
		return;
	}
	options.persistLocal();
	options.changeToLocal();
}

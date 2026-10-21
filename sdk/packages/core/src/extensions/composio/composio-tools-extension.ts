import { createHash } from "node:crypto";
import { join } from "node:path";
import type { AgentExtension, BasicLogger } from "@cline/shared";
import { resolveClineDataDir } from "@cline/shared/storage";

// Preserve the address of saved state without reading, migrating, or deleting it.
export function resolveComposioToolsStatePath(accountId: string): string {
	const key = createHash("sha256").update(accountId).digest("hex");
	return join(resolveClineDataDir(), "settings", "composio", key + ".json");
}

/** Cline-hosted connector tools are excluded in every cline-qb host. */
export async function createComposioToolsExtension(_options?: {
	logger?: BasicLogger;
}): Promise<AgentExtension | undefined> {
	return undefined;
}

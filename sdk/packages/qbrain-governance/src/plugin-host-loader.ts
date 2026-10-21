// SPDX-License-Identifier: Apache-2.0
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type AgentRuntimeConfig, createTool } from "@cline/shared";
import type { VerifiedWorkspacePolicy } from "@qbrainai/qbrain-ai-plugin-core";
import type {
	InstalledPlugin,
	PreparedPluginInstallation,
} from "./plugin-installation";
import type { RequiredModelContextSource } from "./required-model-policy";

export interface GovernedPluginHost extends RequiredModelContextSource {
	readonly readVerificationPolicy: () => Promise<VerifiedWorkspacePolicy>;
	readonly requiredTools: NonNullable<AgentRuntimeConfig["requiredTools"]>;
	readonly hooks: NonNullable<AgentRuntimeConfig["hooks"]>;
}

/**
 * Consume only a host-prepared, signed-pin-authorized installation. Signature and
 * marker authorization must precede this call. This loader verifies the entire
 * installed inventory before importing the SDK-independent private entrypoint.
 * It does not approve a pin or establish durable host lifecycle readiness.
 */
export async function loadVerifiedPluginHost(options: {
	installation: PreparedPluginInstallation;
	/** Existing private product directory selected by the host storage policy. */
	parentDirectory: string;
}): Promise<{
	readonly installed: InstalledPlugin;
	createHost(config: Readonly<Record<string, unknown>>): GovernedPluginHost;
}> {
	const installation = options.installation;
	let installed: InstalledPlugin | undefined;
	const failure = () =>
		new Error(
			"Required governed plugin could not be loaded from its verified installation.",
		);
	try {
		installed = installation.install(options.parentDirectory);
		const captured = installed;
		installation.verify(captured.root);
		const manifest = JSON.parse(
			readFileSync(join(captured.root, "package.json"), "utf8"),
		);
		if (manifest.exports?.["./host"]?.import !== "./dist/host.js")
			throw failure();
		const api: unknown = await import(
			pathToFileURL(join(captured.root, "dist/host.js")).href
		);
		const factory = (api as { createGovernedMcpServerHost?: unknown })
			?.createGovernedMcpServerHost;
		if (typeof factory !== "function") throw failure();
		return Object.freeze({
			installed: captured,
			createHost(
				config: Readonly<Record<string, unknown>>,
			): GovernedPluginHost {
				try {
					const capturedConfig = { ...config, pluginRoot: captured.root };
					installation.verify(captured.root);
					const host: unknown = factory(capturedConfig, { createTool });
					if (!host || typeof host !== "object") throw failure();
					const value = host as GovernedPluginHost;
					if (
						!Array.isArray(value.requiredTools) ||
						!value.requiredTools.length ||
						!value.hooks ||
						typeof value.hooks !== "object" ||
						typeof value.getRequiredModelContext !== "function" ||
						typeof value.readVerificationPolicy !== "function"
					)
						throw failure();
					return value;
				} catch {
					throw failure();
				}
			},
		});
	} catch {
		if (installed) {
			try {
				rmSync(installed.root, { recursive: true, force: true });
			} catch {
				/* Preserve the original refusal. */
			}
		}
		throw failure();
	}
}

// SPDX-License-Identifier: Apache-2.0
import { isAbsolute, resolve } from "node:path";
import {
	fullBootstrap,
	type RequiredAgentPluginBinding,
	verifyPinnedPluginArtifact,
} from "@qbrainai/qbrain-ai-plugin-core";
import {
	captureGovernanceBuildDigest,
	createGovernedHubIdentity,
} from "./hub-build-identity";
import {
	type GovernedPluginHost,
	loadVerifiedPluginHost,
} from "./plugin-host-loader";
import { preparePluginInstallation } from "./plugin-installation";

/** Host-owned build inputs, never marker-selected paths or model arguments. */
export interface TrustedPluginBootstrapOptions {
	readonly workspacePath: string;
	readonly artifactPath: string;
	readonly binding: RequiredAgentPluginBinding;
	readonly parentDirectory: string;
	readonly fetch: typeof globalThis.fetch;
}

/**
 * Authorize the exact workspace and reviewed archive with canonical plugin-core,
 * then install/import those captured bytes. This does not approve candidate pins
 * or supply the A8/S6 lifecycle, verification policy, REPL layout or final gates.
 */
export async function bootstrapGovernedPlugin(
	options: TrustedPluginBootstrapOptions,
) {
	const failure = () =>
		new Error(
			"Governed plugin startup requires authenticated workspace trust and the exact reviewed artifact.",
		);
	try {
		if (
			!isAbsolute(options.workspacePath) ||
			typeof options.fetch !== "function"
		)
			throw failure();
		const buildDigest = captureGovernanceBuildDigest();
		const workspacePath = resolve(options.workspacePath);
		const fetcher = options.fetch;
		const parentDirectory = options.parentDirectory;
		const binding = Object.freeze({
			agentName: options.binding?.agentName,
			pluginName: options.binding?.pluginName,
			pluginVersion: options.binding?.pluginVersion,
			artifactSha256: options.binding?.artifactSha256,
		});
		if (
			binding.agentName !== "ClineQb" ||
			binding.pluginName !== "@sharpninja/mcpserver-cline-v2-plugin"
		)
			throw failure();
		const artifact = verifyPinnedPluginArtifact({
			artifactPath: options.artifactPath,
			binding,
		});
		const authorize = async () => {
			const marker = await fullBootstrap(workspacePath, {
				expectedWorkspacePath: workspacePath,
				fetch: fetcher,
				requiredAgentPlugin: artifact.binding,
			});
			if (!marker.agentPluginContract) throw failure();
			// Expose only binding metadata, never the marker, API key, signature or endpoint.
			return Object.freeze({ ...marker.agentPluginContract });
		};
		const contract = await authorize();
		const peerIdentity = createGovernedHubIdentity(
			buildDigest,
			artifact.binding,
		);
		const installation = await preparePluginInstallation({
			bytes: artifact.readBytes(),
			binding: artifact.binding,
			requiredFiles: [
				"dist/host.js",
				"CORE-MANIFEST.yaml",
				"memory-descriptor.json",
				"guidance/governed.md",
				"lib/repl-invoke.ps1",
			],
		});
		const loaded = await loadVerifiedPluginHost({
			installation,
			parentDirectory,
		});
		return Object.freeze({
			workspacePath,
			contract,
			peerIdentity,
			installed: loaded.installed,
			async createHost(
				config: Readonly<Record<string, unknown>>,
			): Promise<GovernedPluginHost> {
				try {
					const capturedConfig = {
						...config,
						workspacePath,
						agentName: artifact.binding.agentName,
						requiredAgentPlugin: artifact.binding,
						fetch: fetcher,
					};
					const current = await authorize();
					if (current.contractDigest !== contract.contractDigest)
						throw failure();
					return loaded.createHost(capturedConfig);
				} catch {
					throw failure();
				}
			},
		});
	} catch {
		throw failure();
	}
}

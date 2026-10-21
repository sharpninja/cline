// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import type { HubPeerIdentity } from "@cline/shared";
import type { RequiredAgentPluginBinding } from "@qbrainai/qbrain-ai-plugin-core";

declare const __CLINE_QB_GOVERNANCE_BUILD_DIGEST__: string;

/** Missing build preparation fails closed; environment values are never consulted. */
export function captureGovernanceBuildDigest(): string {
	const digest =
		typeof __CLINE_QB_GOVERNANCE_BUILD_DIGEST__ === "undefined"
			? undefined
			: __CLINE_QB_GOVERNANCE_BUILD_DIGEST__;
	if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) {
		throw new Error(
			"Governance build identity is unavailable. Build the governed SDK before startup.",
		);
	}
	return digest;
}

/** Call only after canonical workspace trust and artifact verification succeed. */
export function createGovernedHubIdentity(
	buildDigest: string,
	binding: Readonly<RequiredAgentPluginBinding>,
): Readonly<HubPeerIdentity> {
	const artifactSha256 = binding.artifactSha256.toLowerCase();
	if (
		!/^[a-f0-9]{64}$/.test(buildDigest) ||
		!/^[a-f0-9]{64}$/.test(artifactSha256)
	) {
		throw new Error("Governance build or artifact identity is invalid.");
	}
	// This identifies common enforcement, not a workspace's signed verification policy.
	const policyDigest = createHash("sha256")
		.update(
			JSON.stringify([
				"cline-qb-hub-policy-build-v1",
				buildDigest,
				binding.agentName,
				binding.pluginName,
				binding.pluginVersion,
				artifactSha256,
			]),
		)
		.digest("hex");
	return Object.freeze({ applicationId: "cline-qb", policyDigest });
}

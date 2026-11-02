// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import type {
	IdentityFault,
	PluginIdentityInput,
	PluginIdentityObservation,
} from "./p1-plugin-identity-contract";

/**
 * Independent input-only identity model. Reads no vectors or expected outcomes,
 * and performs no I/O, signature verification, archive extraction or product work.
 * @param input - Captured host pin and independently scripted dependency replies.
 * @param fault - One test-only bypass to prove the unchanged assertions reject it.
 * @returns Ordered observed checks/effects and the retained authorization outcome.
 * @remarks
 * Change log:
 * - 2026-11-02 | FR-QB-001, FR-QB-002;
 *   AC-QB-BLOCKS-EXECUTION-WHEN-REQUIRED-PLUGIN-IS-UNUSABLE,
 *   AC-QB-FAILS-CLOSED-ON-WORKSPACE-TRUST-FAILURE | Establish rejecting controls
 *   for strict three-authority identity; no production binding or acceptance.
 */
export async function runPluginIdentityModel(
	input: PluginIdentityInput,
	fault?: IdentityFault,
): Promise<PluginIdentityObservation> {
	const observed: PluginIdentityObservation = {
		outcome: "blocked",
		operations: [],
		acceptedBinding: null,
		imports: 0,
		ordinaryExecutions: 0,
		aliasFallbacks: 0,
		diagnostic:
			"Governed plugin startup requires authenticated workspace trust and the exact reviewed artifact.",
		exercisedFaults: [],
	};
	const bypass = (kind: IdentityFault) => {
		if (fault !== kind) return false;
		observed.exercisedFaults.push(kind);
		return true;
	};
	const pin = structuredClone(input.hostPin);
	observed.operations.push("host.identity");
	if (bypass("import-before-validation")) {
		observed.operations.push("plugin.import");
		observed.imports++;
	}
	if (
		pin.agentName !== "ClineQb" ||
		(pin.pluginName !== "@qbrainai/qbrain-ai-cline-v2-plugin" &&
			!bypass("accept-legacy-host"))
	)
		return observed;
	observed.operations.push("artifact.verify");
	if (
		createHash("sha256").update(input.archiveBytes).digest("hex") !==
			pin.artifactSha256.toLowerCase() &&
		!bypass("ignore-archive-digest")
	)
		return observed;
	observed.operations.push("marker.authenticate");
	const signed = input.signedBinding;
	if (
		signed.agentName !== pin.agentName ||
		(signed.pluginName !== pin.pluginName && !bypass("ignore-signed-name")) ||
		(signed.pluginVersion !== pin.pluginVersion &&
			!bypass("ignore-signed-version")) ||
		(signed.artifactSha256.toLowerCase() !== pin.artifactSha256.toLowerCase() &&
			!bypass("ignore-signed-digest"))
	)
		return observed;
	observed.operations.push("manifest.read");
	const manifest = input.manifestReply;
	if (
		manifest.name !== pin.pluginName &&
		!bypass("ignore-manifest-name") &&
		!(
			manifest.qbrainAiLegacyName === pin.pluginName &&
			bypass("use-legacy-manifest-alias")
		)
	)
		return observed;
	if (observed.exercisedFaults.includes("use-legacy-manifest-alias"))
		observed.aliasFallbacks++;
	if (
		manifest.version !== pin.pluginVersion &&
		!bypass("ignore-manifest-version")
	)
		return observed;
	observed.operations.push("plugin.install", "plugin.import");
	observed.imports++;
	observed.outcome = "ready";
	observed.diagnostic = null;
	observed.acceptedBinding = {
		...pin,
		artifactSha256: pin.artifactSha256.toUpperCase(),
	};
	return observed;
}

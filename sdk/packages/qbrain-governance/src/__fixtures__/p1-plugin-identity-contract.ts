// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";

/**
 * Shared assertions for the reviewed host pin, authenticated marker projection,
 * and packaged manifest. Test adapters must observe these authorities separately.
 * @remarks
 * Change log:
 * - 2026-11-02 | FR-QB-001, FR-QB-002; TR-QB-PLUGIN-001, TR-QB-TRUST-001;
 *   AC-QB-BLOCKS-EXECUTION-WHEN-REQUIRED-PLUGIN-IS-UNUSABLE,
 *   AC-QB-FAILS-CLOSED-ON-WORKSPACE-TRUST-FAILURE | Freeze exact package identity
 *   assertions before changing production bindings; no artifact acceptance implied.
 */
export interface PluginIdentityBinding {
	agentName: string;
	pluginName: string;
	pluginVersion: string;
	artifactSha256: string;
}

export interface PluginIdentityInput {
	hostPin: PluginIdentityBinding;
	signedBinding: PluginIdentityBinding;
	archiveBytes: Uint8Array;
	/** Scripted parser reply for the independent mock; production must parse bytes. */
	manifestReply: { name: string; version: string; qbrainAiLegacyName?: string };
}

export type IdentityFault =
	| "accept-legacy-host"
	| "ignore-signed-name"
	| "ignore-signed-version"
	| "ignore-signed-digest"
	| "ignore-archive-digest"
	| "use-legacy-manifest-alias"
	| "ignore-manifest-name"
	| "ignore-manifest-version"
	| "import-before-validation";

export interface PluginIdentityObservation {
	outcome: "ready" | "blocked";
	operations: string[];
	acceptedBinding: PluginIdentityBinding | null;
	imports: number;
	ordinaryExecutions: number;
	aliasFallbacks: number;
	diagnostic: string | null;
	exercisedFaults: IdentityFault[];
}

export interface PluginIdentityScenario {
	id: string;
	input: PluginIdentityInput;
	expected: Omit<PluginIdentityObservation, "exercisedFaults">;
	controls: IdentityFault[];
}

/**
 * Compare the complete observed authorization order and identity, including
 * zero imports/ordinary dispatch on refusal. The same assertions bind production.
 * @param scenario - Requirement-derived input and independently declared outcome.
 * @param observation - Captured adapter operations and effects, never expectations.
 * @throws {assert.AssertionError} If any required observation differs.
 * @remarks
 * Change log:
 * - 2026-11-02 | FR-QB-001, FR-QB-002;
 *   AC-QB-BLOCKS-EXECUTION-WHEN-REQUIRED-PLUGIN-IS-UNUSABLE,
 *   AC-QB-FAILS-CLOSED-ON-WORKSPACE-TRUST-FAILURE | Preserve one assertion contract
 *   for the independent mock and subsequent real bootstrap binding.
 */
export function assertPluginIdentity(
	scenario: PluginIdentityScenario,
	observation: PluginIdentityObservation,
): void {
	const { exercisedFaults: _faults, ...actual } = observation;
	assert.deepStrictEqual(
		actual,
		scenario.expected,
		"PLUGIN_IDENTITY: authorization or effects differ",
	);
}

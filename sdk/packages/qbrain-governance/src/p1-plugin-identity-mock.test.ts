// SPDX-License-Identifier: Apache-2.0
/**
 * Independent package-identity prerequisite; no product bootstrap or artifact acceptance.
 * @remarks
 * Change log:
 * - 2026-11-02 | FR-QB-001, FR-QB-002; TEST-QB-003, TEST-QB-004;
 *   AC-QB-BLOCKS-EXECUTION-WHEN-REQUIRED-PLUGIN-IS-UNUSABLE,
 *   AC-QB-FAILS-CLOSED-ON-WORKSPACE-TRUST-FAILURE | Preserve exact matching and
 *   rejection assertions before production identity changes.
 */
import assert, { AssertionError } from "node:assert/strict";
import { describe, it } from "vitest";
import { pluginIdentityScenarios } from "./__fixtures__/p1-plugin-identity-cases";
import { assertPluginIdentity } from "./__fixtures__/p1-plugin-identity-contract";
import { runPluginIdentityModel } from "./__fixtures__/p1-plugin-identity-model";

describe("P1 independent exact package identity", () => {
	for (const scenario of pluginIdentityScenarios) {
		it(scenario.id, async () => {
			const input = structuredClone(scenario.input);
			const before = structuredClone(input);
			const observation = await runPluginIdentityModel(input);
			assertPluginIdentity(scenario, observation);
			assert.deepStrictEqual(observation.exercisedFaults, []);
			assert.deepStrictEqual(input, before, "PLUGIN_IDENTITY: input mutated");
			console.log(
				JSON.stringify({
					scenario: scenario.id,
					productionBound: false,
					observation,
				}),
			);
		});
		for (const fault of scenario.controls)
			it("SAME assertions reject " + scenario.id + "/" + fault, async () => {
				const input = structuredClone(scenario.input);
				const before = structuredClone(input);
				const observation = await runPluginIdentityModel(input, fault);
				assert.deepStrictEqual(
					observation.exercisedFaults,
					[fault],
					"PLUGIN_IDENTITY: fault not exercised",
				);
				assert.throws(
					() => assertPluginIdentity(scenario, observation),
					(error) =>
						error instanceof AssertionError &&
						error.code === "ERR_ASSERTION" &&
						error.message.startsWith("PLUGIN_IDENTITY:"),
				);
				assert.deepStrictEqual(
					input,
					before,
					"PLUGIN_IDENTITY: control input mutated",
				);
				console.log(
					JSON.stringify({
						scenario: scenario.id,
						fault,
						assertionRejected: true,
						productionBound: false,
						observation,
					}),
				);
			});
	}
});

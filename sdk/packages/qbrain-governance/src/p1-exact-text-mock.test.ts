// SPDX-License-Identifier: Apache-2.0
import { describe, it } from "vitest";
import { p1ExactTextCases } from "./__fixtures__/p1-exact-text-cases";
import {
	assertScenario,
	dependencyControls,
	independentDriver,
	negativeControls,
	rejectBoundary,
	rejectNegative,
} from "./p1-contract-mock.test";

/** Same frozen runner/assertions and independent input-only governance model.
 * Captured requests, callbacks, journal writes and effect omissions determine
 * observations; this file never scripts the scenario expected object as output.
 * Production adapter substitution and a new cumulative package gate remain open.
 * Importing the runner registers its original 830 checks, not new unique coverage.
 */
describe("AC-QB-069 exact final text mock boundaries (not production evidence)", () => {
	for (const scenario of p1ExactTextCases) {
		it(scenario.name, async () => {
			const driver = independentDriver();
			await assertScenario(scenario, driver);
			const controls = dependencyControls(driver);
			for (const control of controls) await rejectBoundary(scenario, control);
			console.log({
				scenario: scenario.name,
				correct: true,
				rejectedBoundaryControls: controls.length,
				capturedRequests: driver.dependencies,
				capturedEffects: driver.effects,
				productionBound: false,
			});
		});
		it(`${scenario.name}: rejects comparator and invocation faults`, async () => {
			for (const control of negativeControls(scenario))
				await rejectNegative(scenario, control);
		});
	}
});

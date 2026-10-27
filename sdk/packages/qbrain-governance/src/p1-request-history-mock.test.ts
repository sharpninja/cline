// SPDX-License-Identifier: Apache-2.0
import assert, { AssertionError } from "node:assert/strict";
import { describe, it } from "vitest";
import { p1RequestHistoryCases } from "./__fixtures__/p1-request-history-cases";
import {
	auditHistoryFaults,
	type AuditHistoryFault,
} from "./__fixtures__/p1-request-history-model";
import { GovernanceModel } from "./__fixtures__/p1-governance-model";
import {
	assertScenario,
	dependencyControls,
	independentDriver,
	negativeControls,
	rejectBoundary,
	rejectNegative,
} from "./p1-contract-mock.test";

/** Same original runner and captured dependency/effect assertions. Importing it
 * registers 830 original checks again; these are not additional unique coverage.
 * No production behavior, dependency artifact or competing lifecycle is shipped.
 */
describe("AC-QB-069 complete request/event/result history mocks (production unbound)", () => {
	for (const scenario of p1RequestHistoryCases) {
		it(scenario.name, async () => {
			const driver = independentDriver();
			await assertScenario(scenario, driver);
			const controls = dependencyControls(driver);
			for (const control of controls) await rejectBoundary(scenario, control);
			console.dir(
				{
					scenario: scenario.name,
					correct: true,
					rejectedBoundaryControls: controls.length,
					capturedRequests: driver.dependencies,
					capturedEffects: driver.effects,
					productionBound: false,
				},
				{ depth: null, maxArrayLength: null, maxStringLength: null },
			);
		});
		it(`${scenario.name}: exact-set assertions reject corrupted plugin records and block completion`, async () => {
			const rawTexts = (
				scenario.steps[0].input.history as { text?: string }[]
			).flatMap((event) => (event.text === undefined ? [] : [event.text]));
			const faults: AuditHistoryFault[] = [...auditHistoryFaults];
			if (rawTexts.some((text) => text.normalize("NFC") !== text))
				faults.push("unicode-normalization");
			if (rawTexts.some((text) => text.includes("\\r")))
				faults.push("literal-unescape");
			for (const fault of faults) {
				const driver = new GovernanceModel(undefined, fault);
				await assert.rejects(
					() => assertScenario(scenario, driver),
					(error) => error instanceof AssertionError,
					fault,
				);
				await driver.finish();
				assert.equal(
					driver.effects.filter(
						(effect) => effect.target === "completion-authorized",
					).length,
					0,
					`${fault}: corrupt evidence authorized completion`,
				);
				assert.deepStrictEqual(
					driver.effects.filter((effect) => effect.target === "diagnostic"),
					[{ target: "diagnostic", payload: { exactEventSet: false } }],
					`${fault}: blocked result must expose diagnosis`,
				);
				assert.ok(
					driver.dependencies.some(
						(call) => call.method === "plugin.readExactEventSet",
					),
					`${fault}: must exercise readback`,
				);
			}
			console.log({
				scenario: scenario.name,
				rejectedHistoryFaults: faults,
				productionBound: false,
			});
		});
		it(`${scenario.name}: unchanged runner rejects comparator and invocation faults`, async () => {
			const controls = negativeControls(scenario);
			for (const control of controls) await rejectNegative(scenario, control);
			console.log({
				scenario: scenario.name,
				rejectedComparatorControls: controls.length,
			});
		});
	}
});

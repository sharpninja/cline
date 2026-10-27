// SPDX-License-Identifier: Apache-2.0
import assert, { AssertionError } from "node:assert/strict";
import { describe, it } from "vitest";
import { receiptRevisionCases } from "./__fixtures__/p1-receipt-revision-cases";
import {
	ReceiptRevisionFake,
	type RevisionFault,
} from "./__fixtures__/p1-receipt-revision-model";
import { assertScenario } from "./p1-contract-mock.test";

// Importing the frozen runner also registers its original830 tests. Those are
// retained regression checks, not additional unique requirement coverage.
describe("AC-QB-009 positive committed revision independent mock gate", () => {
	for (const scenario of receiptRevisionCases) {
		it(scenario.name, async () => {
			const fake = new ReceiptRevisionFake();
			await assertScenario(scenario, fake);
			console.dir(
				{
					scenario: scenario.name,
					productionBound: false,
					requests: fake.plugin.requests,
					callbackTrace: fake.plugin.trace,
					effects: fake.effects,
					retained: [...fake.journal],
				},
				{ depth: null },
			);
		});
		it(`${scenario.name}: rejects dependency, effect and state faults`, async () => {
			const correct = new ReceiptRevisionFake();
			await assertScenario(scenario, correct);
			const faults: { kind: RevisionFault; at: number }[] =
				correct.plugin.requests.flatMap((_request, at) =>
					(
						[
							"wrong-response",
							"missing-response",
							"reordered-callback",
							"missing-callback",
						] as const
					).map((kind) => ({ kind, at })),
				);
			faults.push({ kind: "omit-effect", at: 0 });
			const first = scenario.steps[0].input;
			const raw = (first.transport ?? first.receipt) as Record<string, unknown>;
			if (!(typeof raw.serverRevision === "number" && raw.serverRevision > 0))
				faults.push(
					{ kind: "accept-nonpositive", at: 0 },
					{ kind: "lose-retained", at: 0 },
				);
			for (const fault of faults) {
				await assert.rejects(
					() =>
						assertScenario(
							scenario,
							new ReceiptRevisionFake(fault.kind, fault.at),
						),
					(error) => error instanceof AssertionError,
					`${scenario.name}: ${fault.kind} at dependency${fault.at}`,
				);
			}
			console.log({ scenario: scenario.name, rejectedControls: faults.length });
		});
	}
});

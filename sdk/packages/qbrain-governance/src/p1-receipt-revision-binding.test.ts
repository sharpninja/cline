// SPDX-License-Identifier: Apache-2.0
import { describe, it } from "vitest";
import { GovernanceModel } from "./__fixtures__/p1-governance-model";
import { receiptRevisionCases } from "./__fixtures__/p1-receipt-revision-cases";
import { assertScenario } from "./p1-contract-mock.test";

// SAME immutable inputs, expected observations and runner as the independent
// receipt fake gate. This binding is still TEST-MODEL evidence, not production.
describe("AC-QB-009 committed revision binding to existing governance test model", () => {
	for (const scenario of receiptRevisionCases) {
		it(scenario.name, async () => {
			const model = new GovernanceModel();
			await assertScenario(scenario, model);
		});
	}
});

// SPDX-License-Identifier: Apache-2.0
/** AC-QB-009 / TEST-QB-009: equality does not establish a positive committed
 * revision. These additional vectors preserve every original contract vector.
 * Expected observations are requirement-derived, never model output. */
import type { ContractCase, Step } from "./p1-contract-cases";

const root = {
	workspaceId: "fixture-workspace-a",
	agentIdentity: "ClineQb",
	mcpSessionId: "fixture-session-a",
	requestId: "fixture-request-a",
};
const base = {
	...root,
	eventId: "event-a",
	order: 7,
	method: "audit",
	payloadHash: "b".repeat(64),
	code: "persisted",
};
const blocked = {
	outcome: "blocked",
	ordinaryExecutions: 0,
	successEvents: 0,
	diagnosticsDeliverable: true,
	evidenceRetained: true,
	supportedRecovery: true,
};
const complete = {
	outcome: "complete",
	successEvents: 1,
	requestId: root.requestId,
};
function receipt(revision: unknown): Record<string, unknown> {
	return revision === undefined
		? { ...base }
		: { ...base, serverRevision: revision };
}
function submission(
	mode: "persisted" | "unchanged",
	revision: unknown,
	positive: boolean,
): Step {
	const value = receipt(revision);
	return {
		operation: "afterTool",
		input:
			mode === "persisted"
				? { expected: value, transport: value }
				: {
						code: "unchanged",
						matchingReadback: true,
						expected: value,
						receipt: value,
					},
		expected: positive
			? mode === "persisted"
				? { confirmed: true, receipt: value, mandatoryOutstanding: 0 }
				: { confirmed: true, receipt: { ...value, code: "unchanged" } }
			: mode === "persisted"
				? { confirmed: false, evidenceRetained: true }
				: { confirmed: false },
	};
}
const cases: ContractCase[] = [];
// Numeric 1 is the lower positive boundary; 9 preserves the original valid value.
// Missing and a numeric string do not establish a committed numeric revision.
for (const mode of ["persisted", "unchanged"] as const) {
	for (const [label, revision, positive] of [
		["one", 1, true],
		["nine", 9, true],
		["zero", 0, false],
		["negative", -1, false],
		["missing", undefined, false],
		["numeric-string", "9", false],
	] as const) {
		cases.push({
			name: `${mode} matching receipt revision ${label}`,
			requirements: ["AC-QB-009", "TEST-QB-009"],
			steps: [
				submission(mode, revision, positive),
				{
					operation: "beforeCompletion",
					input: { kind: "text", pendingCount: 0 },
					expected: positive ? complete : blocked,
				},
			],
		});
	}
	cases.push({
		name: `${mode} retained invalid revision clears only after a verified valid receipt`,
		requirements: ["AC-QB-009", "TEST-QB-009"],
		steps: [
			submission(mode, 0, false),
			{
				operation: "beforeCompletion",
				input: { kind: "text", pendingCount: 0 },
				expected: blocked,
			},
			submission(mode, 9, true),
			{
				operation: "beforeCompletion",
				input: { kind: "text", pendingCount: 0 },
				expected: complete,
			},
		],
	});
}
export const receiptRevisionCases: readonly ContractCase[] = cases;

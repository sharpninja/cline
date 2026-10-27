// SPDX-License-Identifier: Apache-2.0
import type { ContractCase } from "./p1-contract-cases";

/** AC-QB-007/008/009/069; UC-QB-002.flow-3.step-29, flow-4.step-30;
 * UC-QB-003.flow-5.step-31, flow-6.step-32. Independent fixture expectations:
 * every ingress body is complete, metadata does not replace it, only prepared
 * finals exist, replay preserves logical identity/order, equal text is not a key.
 * No production title algorithm or new lifecycle is specified by these fixtures.
 */
const a = {
	workspaceId: "fixture-workspace-a",
	agentIdentity: "ClineQb",
	hostSessionKey: "native-a",
	mcpSessionId: "fixture-session-a",
	requestId: "fixture-request-a",
};
const b = { ...a, requestId: "fixture-steering-b" };
const variants = [
	["CRLF", "Inspect\r\n\r\nfull request\r\n", "Request: Inspect full request"],
	["CR-only", "Inspect\r\rfull request\r", "Request: Inspect full request"],
	[
		"mixed-newlines",
		"Inspect\r\nline-two\nline-three\rline-four\r\n",
		"Request: Inspect line-two line-three line-four",
	],
	[
		"surrounding-whitespace",
		"  Inspect\t request \r\n\r\n",
		"Request: Inspect request",
	],
	[
		"unrelated-Unicode",
		"caf\u00e9 cafe\u0301 \u4e2d \ud83d\ude80\r\n\u00a0",
		"Request: caf\u00e9 cafe\u0301 \u4e2d \ud83d\ude80",
	],
	[
		"literal-escapes",
		"literal \\r\\n and \\u00e9\r\n",
		"Request: literal \\r\\n and \\u00e9",
	],
	[
		"Markdown-tabs",
		"```text\r\n\t exact\t\r\n```\r\n\r\n",
		"Request: ```text exact ```",
	],
	["ASCII-hyphens", "- ASCII -- request\r\n", "Request: - ASCII -- request"],
] as const;
type Root = typeof a;
const ingress = (context: Root, text: string) => ({
	kind: "ingress",
	context,
	eventId: "ingress-1",
	text,
});
const final = (context: Root, text: string) => ({
	kind: "final",
	context,
	eventId: "final-1",
	text,
});
const replay = (context: Root, recordKind: string) => ({
	kind: "replay",
	context,
	eventId: recordKind === "ingress" ? "ingress-1" : "final-1",
	recordKind,
});
const cancel = (context: Root) => ({ kind: "cancel", context });
const requestRecord = (
	context: Root,
	order: number,
	text: string,
	title: string,
) => ({
	...context,
	eventId: "ingress-1",
	kind: "ingress",
	order,
	text,
	title,
});
const finalRecord = (context: Root, order: number, text: string) => ({
	...context,
	eventId: "final-1",
	kind: "final",
	order,
	text,
});
const status = (context: Root, state: string, title: string) => ({
	...context,
	status: state,
	title,
});
const crossRoots: readonly [string, Root][] = [
	["native-session", { ...a, hostSessionKey: "native-b" }],
	["MCP-session", { ...a, mcpSessionId: "fixture-session-b" }],
	["workspace", { ...a, workspaceId: "fixture-workspace-b" }],
	["agent", { ...a, agentIdentity: "fixture-other-agent" }],
];
export const p1RequestHistoryCases: readonly ContractCase[] = variants.flatMap(
	([name, text, title]) => {
		const cases: {
			label: string;
			history: unknown[];
			records: unknown[];
			requests: unknown[];
			effectOrder: (number | "cancel-a" | "cancel-b")[];
			terminalOutcome?: "canceled";
		}[] = [
			{
				effectOrder: [0, 1],
				label: "complete ingress and final replay",
				history: [
					ingress(a, text),
					final(a, text),
					replay(a, "ingress"),
					replay(a, "final"),
					replay(a, "final"),
				],
				records: [requestRecord(a, 1, text, title), finalRecord(a, 2, text)],
				requests: [status(a, "final-persisted", title)],
			},
			{
				effectOrder: [0, 1, "cancel-a", 2],
				label: "steering before final persistence cancels only original",
				history: [
					ingress(a, text),
					ingress(b, text),
					cancel(a),
					final(b, text),
					replay(a, "ingress"),
				],
				records: [
					requestRecord(a, 1, text, title),
					requestRecord(b, 2, text, title),
					finalRecord(b, 3, text),
				],
				requests: [
					status(a, "canceled", title),
					status(b, "final-persisted", title),
				],
			},
			{
				effectOrder: [0, 1, 2, 3],
				label:
					"steering after final persistence retains both request result sets",
				history: [
					ingress(a, text),
					final(a, text),
					ingress(b, text),
					final(b, text),
					replay(a, "final"),
				],
				records: [
					requestRecord(a, 1, text, title),
					finalRecord(a, 2, text),
					requestRecord(b, 3, text, title),
					finalRecord(b, 4, text),
				],
				requests: [
					status(a, "final-persisted", title),
					status(b, "final-persisted", title),
				],
			},
			{
				effectOrder: [0, "cancel-a", 1, "cancel-b"],
				label: "cancellation and ingress replay invent no final",
				terminalOutcome: "canceled",
				history: [
					ingress(a, text),
					cancel(a),
					ingress(b, text),
					cancel(b),
					replay(a, "ingress"),
					replay(b, "ingress"),
				],
				records: [
					requestRecord(a, 1, text, title),
					requestRecord(b, 2, text, title),
				],
				requests: [status(a, "canceled", title), status(b, "canceled", title)],
			},
			...crossRoots.map(([axis, other]) => ({
				effectOrder: [0, 1, 2, 3],
				label: `identical request IDs and text preserve distinct ${axis} roots`,
				history: [
					ingress(a, text),
					final(a, text),
					ingress(other, text),
					final(other, text),
					replay(a, "ingress"),
					replay(other, "final"),
				],
				records: [
					requestRecord(a, 1, text, title),
					finalRecord(a, 2, text),
					requestRecord(other, 3, text, title),
					finalRecord(other, 4, text),
				],
				requests: [
					status(a, "final-persisted", title),
					status(other, "final-persisted", title),
				],
			})),
		];
		return cases.map((value) => ({
			name: `${name}: ${value.label}`,
			requirements: ["AC-QB-007", "AC-QB-008", "AC-QB-009", "AC-QB-069"],
			steps: [
				{
					operation: "beforeCompletion",
					input: { history: value.history },
					expected: {
						outcome: value.terminalOutcome ?? "complete",
						records: value.records,
						requests: value.requests,
						logicalRecordCount: value.records.length,
						effectTrace: [
							...value.effectOrder.map((item) =>
								typeof item === "number"
									? { target: "audit-record", payload: value.records[item] }
									: {
											target: "request-canceled",
											payload: item === "cancel-a" ? a : b,
										},
							),
							{
								target: value.terminalOutcome
									? "cancellation-evidence-verified"
									: "completion-authorized",
								payload: { exactEventSet: true },
							},
						],
						operatorReceived: false,
					},
				},
			],
		}));
	},
);

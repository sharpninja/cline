// SPDX-License-Identifier: Apache-2.0
import type { ContractCase } from "./p1-contract-cases";

/** AC-QB-069 / UC-QB-003.flow-5.step-31 and flow-6.step-32.
 * Requirement: preserve final-result text ordinally, including all newline forms,
 * Markdown and unrelated Unicode, through replay. Fixtures contain no prohibited
 * dash characters or secrets, so neither permitted policy transformation applies.
 * The independent driver receives only operation/input, never these expectations.
 * Request-ingress/title, completion-set and production binding remain separate gates.
 */
const identity = {
	workspaceId: "fixture-workspace-a",
	agentIdentity: "ClineQb",
	mcpSessionId: "fixture-session-a",
	requestId: "fixture-request-a",
};
const texts = [
	["CRLF", "# Result\r\n\r\n- preserve\r\n\tindent\r\n"],
	["CR-only", "# Result\r\r- preserve\r"],
	["mixed-newlines", "# Result\r\nline-two\nline-three\rline-four\r\n"],
	["surrounding-whitespace", "  result\t \r\n\r\n"],
	["unrelated-Unicode", "caf\u00e9 cafe\u0301 \u4e2d \ud83d\ude80\r\n\u00a0"],
	["literal-backslashes", "literal \\r\\n and \\u00e9 stay literal\r\n"],
	["Markdown-fence-tabs", "```text\r\n\t  exact\t\r\n```\r\n\r\n"],
	["ASCII-hyphens", "- already-ASCII -- unchanged\r\n"],
] as const;

export const p1ExactTextCases: readonly ContractCase[] = texts.map(
	([name, text]) => ({
		name: `final text preserves ${name} through replay before delivery`,
		requirements: ["AC-QB-069"],
		steps: [
			{
				operation: "persistFinal",
				input: { ...identity, text, deliveryAcknowledged: false, replay: 2 },
				expected: {
					...identity,
					text,
					logicalRecordCount: 1,
					operatorReceived: false,
				},
			},
		],
	}),
);

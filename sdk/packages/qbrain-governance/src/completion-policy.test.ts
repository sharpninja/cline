// SPDX-License-Identifier: Apache-2.0
/** TEST-QB-007/008/010/011: real runtime with host-owned completion evidence. */
import { AgentRuntime } from "@cline/agents";
import type {
	AgentModel,
	AgentModelEvent,
	AgentRuntimeEvent,
} from "@cline/shared";
import { describe, expect, it, vi } from "vitest";
import { createCompletionGate, type CompletionEvidence } from "./index";

const scope = {
	workspaceId: "workspace",
	sessionId: "session",
	turnId: "turn",
};
const digest = "a".repeat(64);
const fingerprint = "b".repeat(64);
function evidence(): CompletionEvidence {
	return {
		scope,
		trust: "verified",
		policyDigest: digest,
		fingerprint,
		continuationLimit: 3,
		infrastructureReady: true,
		audit: { pending: 0, rejected: 0, quarantined: 0, lost: 0 },
		development: true,
		codeChanged: true,
		verification: {
			configured: true,
			requiredIds: ["unit"],
			records: [
				{ id: "unit", status: "passed", fingerprint, policyDigest: digest },
			],
		},
		decision: "recorded",
		title: "Implement requested behavior",
		requestFirstLine: "Please implement this",
		phaseCloseRequired: false,
		phaseReview: "missing",
	};
}
function source(
	onRequest?: (attempt: number) => void,
	events?: AgentModelEvent[],
): AgentModel {
	let attempt = 0;
	return {
		stream: vi.fn(async function* () {
			onRequest?.(++attempt);
			yield* events ?? [
				{ type: "text-delta" as const, text: "FINAL_ANSWER" },
				{ type: "finish" as const, reason: "stop" as const },
			];
		}),
	};
}
function runtime(state: CompletionEvidence, model = source()) {
	return new AgentRuntime({
		model,
		completionGate: createCompletionGate(scope, async () => state),
	});
}

describe("governed completion", () => {
  it("requires the phase matrix even without code edits in the closing turn", async () => {
    const state = evidence();
    state.development = false; state.codeChanged = false;
    state.phaseCloseRequired = true; state.phaseReview = "verified";
    state.verification.records = [];
    expect((await runtime(state).run("Close phase")).status).toBe("blocked");
    state.verification.records = evidence().verification.records;
    expect((await runtime(state).run("Close phase")).status).toBe("completed");
  });
	it("delivers success when all host observations satisfy obligations", async () => {
		expect(await runtime(evidence()).run("Work")).toMatchObject({
			status: "completed",
			outputText: "FINAL_ANSWER",
		});
	});

	it.each([
		"pending",
		"rejected",
		"quarantined",
		"lost",
	] as const)("blocks retained %s audit even when other counts are zero", async (kind) => {
		const state = evidence();
		state.audit[kind] = 1;
		const model = source();
		const agent = runtime(state, model);
		const events: AgentRuntimeEvent[] = [];
		agent.subscribe((event) => {
			events.push(event);
		});
		expect(await agent.run("Work")).toMatchObject({
			status: "blocked",
			iterations: 1,
		});
		expect(JSON.stringify(events)).not.toContain("FINAL_ANSWER");
		expect(model.stream).toHaveBeenCalledOnce();
	});

	it.each([
		"invalid",
		"unavailable",
	] as const)("blocks %s trust without corrective model retries", async (trust) => {
		const state = evidence();
		state.trust = trust;
		const result = await runtime(state).run("Work");
		expect(result).toMatchObject({ status: "blocked", iterations: 1 });
		expect(result.outputText).toContain("trust");
	});

	it("rejects evidence belonging to another turn", async () => {
		const state = evidence();
		state.scope = { ...scope, turnId: "other" };
		expect((await runtime(state).run("Work")).outputText).toContain("scope");
	});

	it("blocks an unavailable host evidence reader", async () => {
		const agent = new AgentRuntime({
			model: source(),
			completionGate: createCompletionGate(scope, async () => {
				throw Error("offline");
			}),
		});
		expect(await agent.run("Work")).toMatchObject({
			status: "blocked",
			iterations: 1,
		});
	});

	it("rejects stale verification and blocks the third unchanged attempt", async () => {
		const state = evidence();
		state.verification.records = [
			{ ...state.verification.records[0], fingerprint: "c".repeat(64) },
		];
		expect(await runtime(state).run("Work")).toMatchObject({
			status: "blocked",
			iterations: 3,
		});
	});

	it("allows completion after corrective verification passes for current sources", async () => {
		const state = evidence();
		state.verification.records = [];
		const model = source((attempt) => {
			if (attempt === 2)
				state.verification.records = evidence().verification.records;
		});
		expect(await runtime(state, model).run("Work")).toMatchObject({
			status: "completed",
			iterations: 2,
		});
	});

	it("resets the correction bound when obligations change", async () => {
		const state = evidence();
		state.verification.records = [];
		state.decision = "missing";
		const model = source((attempt) => {
			if (attempt === 3)
				state.verification.records = evidence().verification.records;
		});
		expect(await runtime(state, model).run("Work")).toMatchObject({
			status: "blocked",
			iterations: 5,
		});
	});

	it("allows documentation completion without code verification and accepts explicit no-decision attestation", async () => {
		const state = evidence();
		state.codeChanged = false;
		state.verification = { configured: false, requiredIds: [], records: [] };
		state.decision = "attested-none";
		expect((await runtime(state).run("Work")).status).toBe("completed");
	});

	it.each([
		"",
		"User prompt",
		"Please implement this",
	])("requires a summary title instead of %j", async (title) => {
		const state = evidence();
		state.title = title;
		expect(await runtime(state).run("Work")).toMatchObject({
			status: "blocked",
			iterations: 3,
		});
	});

	it("requires verified phase review only for phase closure", async () => {
		const state = evidence();
		state.phaseCloseRequired = true;
		expect((await runtime(state).run("Work")).status).toBe("blocked");
		state.phaseReview = "verified";
		expect((await runtime(state).run("Work")).status).toBe("completed");
	});

	it("refuses unconfigured verification for code changes without looping", async () => {
		const state = evidence();
		state.verification.requiredIds = [];
		expect(await runtime(state).run("Work")).toMatchObject({
			status: "blocked",
			iterations: 1,
		});
	});

	it("refuses mixed completion batches before any tool executes", async () => {
		const execute = vi.fn(async () => "ran");
		const events: AgentModelEvent[] = [
			{
				type: "tool-call-delta",
				toolCallId: "finish",
				toolName: "complete",
				input: {},
			},
			{
				type: "tool-call-delta",
				toolCallId: "edit",
				toolName: "edit",
				input: {},
			},
			{ type: "finish", reason: "tool-calls" },
		];
		const agent = new AgentRuntime({
			model: source(undefined, events),
			toolExecution: "parallel",
			tools: [
				{
					name: "complete",
					description: "Finish",
					inputSchema: {},
					lifecycle: { completesRun: true },
					execute,
				},
				{ name: "edit", description: "Edit", inputSchema: {}, execute },
			],
			completionGate: createCompletionGate(scope, async () => evidence()),
		});
		expect(await agent.run("Work")).toMatchObject({
			status: "blocked",
			iterations: 3,
		});
		expect(execute).not.toHaveBeenCalled();
	});
});

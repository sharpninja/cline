// SPDX-License-Identifier: Apache-2.0
/** TEST-QB-010/011: real runtime completion boundaries, including streamed output. */
import type {
	AgentCompletionDecision,
	AgentModel,
	AgentModelEvent,
	AgentRuntimeEvent,
	AgentTool,
} from "@cline/shared";
import { describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "./agent-runtime";

function model(steps: AgentModelEvent[][]): AgentModel {
	return {
		stream: vi.fn(async function* () {
			const step = steps.shift();
			if (!step) throw new Error("Unexpected additional model request");
			yield* step;
		}),
	};
}
const text = (value: string): AgentModelEvent[] => [
	{ type: "text-delta", text: value },
	{ type: "finish", reason: "stop" },
];
const complete = (): AgentModelEvent[] => [
	{ type: "text-delta", text: "COMPLETION_PREFACE" },
	{
		type: "tool-call-delta",
		toolCallId: "complete-1",
		toolName: "complete",
		input: {},
	},
	{ type: "finish", reason: "tool-calls" },
];
const terminal = (
	execute = vi.fn(async () => ({ answer: "TOOL_SUCCESS" })),
): AgentTool => ({
	name: "complete",
	description: "Complete",
	inputSchema: { type: "object" },
	lifecycle: { completesRun: true },
	execute,
});

describe("host completion gate", () => {
	it("withholds streamed final text and success until the async host check allows", async () => {
		let settle!: (decision: AgentCompletionDecision) => void;
		let entered!: () => void;
		const ready = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const gate = new Promise<AgentCompletionDecision>((resolve) => {
			settle = resolve;
		});
		const events: AgentRuntimeEvent[] = [];
		const runtime = new AgentRuntime({
			model: model([text("PRIVATE_CANDIDATE")]),
			completionGate: () => {
				entered();
				return gate;
			},
		});
		runtime.subscribe((event) => {
			events.push(event);
		});
		const running = runtime.run("Do work");
		await ready;
		expect(JSON.stringify(events)).not.toContain("PRIVATE_CANDIDATE");
		expect(JSON.stringify(runtime.snapshot())).not.toContain(
			"PRIVATE_CANDIDATE",
		);
		settle({ outcome: "allow" });
		expect(await running).toMatchObject({
			status: "completed",
			outputText: "PRIVATE_CANDIDATE",
		});
		expect(events.some((event) => event.type === "assistant-text-delta")).toBe(
			true,
		);
	});

	it("allows corrective work without publishing a refused answer", async () => {
		const events: AgentRuntimeEvent[] = [];
		const source = model([text("PREMATURE_SUCCESS"), text("Verified answer")]);
		const gate = vi
			.fn()
			.mockResolvedValueOnce({
				outcome: "continue",
				diagnostic: "Required tests missing",
			})
			.mockResolvedValue({ outcome: "allow" });
		const runtime = new AgentRuntime({ model: source, completionGate: gate });
		runtime.subscribe((event) => {
			events.push(event);
		});
		expect(await runtime.run("Do work")).toMatchObject({
			status: "completed",
			iterations: 2,
			outputText: "Verified answer",
		});
		expect(JSON.stringify(events)).not.toContain("PREMATURE_SUCCESS");
		expect(JSON.stringify(runtime.snapshot())).toContain(
			"Required tests missing",
		);
	});

	it.each([
		"explicit",
		"exception",
		"invalid",
	])("blocks %s gate failure without leaking the candidate or declaring success", async (failure) => {
		const events: AgentRuntimeEvent[] = [];
		const gate = vi.fn(async (): Promise<AgentCompletionDecision> => {
			if (failure === "exception") throw new Error("Infrastructure down");
			if (failure === "invalid")
				return undefined as unknown as AgentCompletionDecision;
			return {
				outcome: "blocked",
				diagnostic: "Audit rejected; recovery required",
			};
		});
		const runtime = new AgentRuntime({
			model: model([text("MUST_NOT_DELIVER")]),
			completionGate: gate,
		});
		runtime.subscribe((event) => {
			events.push(event);
		});
		const result = await runtime.run("Do work");
		expect(result.status).toBe("blocked");
		expect(result.outputText).toBeTruthy();
		expect(JSON.stringify({ result, events })).not.toContain(
			"MUST_NOT_DELIVER",
		);
		expect(
			events
				.filter((event) => event.type === "run-finished")
				.every((event) => event.result.status !== "completed"),
		).toBe(true);
	});

	it("refuses a completion tool before execution", async () => {
		const tool = terminal();
		const runtime = new AgentRuntime({
			model: model([complete()]),
			tools: [tool],
			completionGate: () => ({
				outcome: "blocked",
				diagnostic: "Pending audit",
			}),
		});
		expect(await runtime.run("Do work")).toMatchObject({
			status: "blocked",
			outputText: "Pending audit",
		});
		expect(tool.execute).not.toHaveBeenCalled();
	});

	it("checks rewritten completion arguments after optional hooks", async () => {
		const tool = terminal();
		const runtime = new AgentRuntime({
			model: model([complete()]),
			tools: [tool],
			hooks: { beforeTool: () => ({ input: { rewritten: true } }) },
			completionGate: ({ candidate }) =>
				candidate.content.some(
					(part) =>
						part.type === "tool-call" &&
						(part.input as { rewritten?: boolean }).rewritten,
				)
					? { outcome: "blocked", diagnostic: "Rewritten input denied" }
					: { outcome: "allow" },
		});
		expect(await runtime.run("Work")).toMatchObject({
			status: "blocked",
			outputText: "Rewritten input denied",
		});
		expect(tool.execute).not.toHaveBeenCalled();
	});

	it("stops when host policy reaches its unchanged-obligation continuation bound", async () => {
		let attempts = 0;
		const source = model([
			text("Attempt 1"),
			text("Attempt 2"),
			text("Attempt 3"),
		]);
		const runtime = new AgentRuntime({
			model: source,
			completionGate: () => ({
				outcome: ++attempts < 3 ? "continue" : "blocked",
				diagnostic: "Verification unchanged",
			}),
		});
		expect(await runtime.run("Work")).toMatchObject({
			status: "blocked",
			iterations: 3,
			outputText: "Verification unchanged",
		});
		expect(source.stream).toHaveBeenCalledTimes(3);
	});

	it("rechecks after completion-tool hooks and withholds a result whose audit was rejected", async () => {
		const events: AgentRuntimeEvent[] = [];
		let auditRejected = false;
		const tool = terminal();
		const runtime = new AgentRuntime({
			model: model([complete()]),
			tools: [tool],
			hooks: {
				afterTool: () => {
					auditRejected = true;
				},
			},
			completionGate: () =>
				auditRejected
					? { outcome: "blocked", diagnostic: "Terminal audit rejection" }
					: { outcome: "allow" },
		});
		runtime.subscribe((event) => {
			events.push(event);
		});
		const result = await runtime.run("Do work");
		expect(result).toMatchObject({
			status: "blocked",
			outputText: "Terminal audit rejection",
		});
		expect(tool.execute).toHaveBeenCalledOnce();
		expect(JSON.stringify({ result, events })).not.toContain("TOOL_SUCCESS");
		expect(JSON.stringify({ result, events })).not.toContain(
			"COMPLETION_PREFACE",
		);
	});

	it("does not publish text refused by the existing completion-tool policy", async () => {
		const events: AgentRuntimeEvent[] = [];
		const runtime = new AgentRuntime({
			model: model([text("PREMATURE_TEXT"), complete()]),
			tools: [terminal()],
			completionPolicy: { requireCompletionTool: true },
			completionGate: () => ({ outcome: "allow" }),
		});
		runtime.subscribe((event) => {
			events.push(event);
		});
		const result = await runtime.run("Work");
		expect(result.status).toBe("completed");
		expect(JSON.stringify({ result, events })).not.toContain("PREMATURE_TEXT");
		expect(JSON.stringify(result.messages)).toContain("COMPLETION_PREFACE");
	});
});

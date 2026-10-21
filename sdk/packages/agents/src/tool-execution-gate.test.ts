// SPDX-License-Identifier: Apache-2.0
/** TEST-QB-001/002: mandatory authorization at the actual local dispatch boundary. */
import type {
	AgentModel,
	AgentModelEvent,
	AgentRuntimeConfig,
	AgentToolExecutionDecision,
} from "@cline/shared";
import { describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "./agent-runtime";

type Decision = AgentToolExecutionDecision;
type Gate = NonNullable<AgentRuntimeConfig["toolExecutionGate"]>;
function source(ids = ["one"]): AgentModel {
	const steps: AgentModelEvent[][] = [
		[
			...ids.map((toolCallId) => ({
				type: "tool-call-delta" as const,
				toolCallId,
				toolName: "write",
				input: { path: "initial" },
			})),
			{ type: "finish", reason: "tool-calls" },
		],
		[
			{ type: "text-delta", text: "Done" },
			{ type: "finish", reason: "stop" },
		],
	];
	return {
		stream: vi.fn(async function* () {
			const step = steps.shift();
			if (!step) throw new Error("Unexpected request");
			yield* step;
		}),
	};
}
function setup(
	gate: Gate,
	extra: Partial<AgentRuntimeConfig> = {},
	ids?: string[],
) {
	const execute = vi.fn(async (_input: unknown) => "executed");
	const config: AgentRuntimeConfig = {
		model: source(ids),
		tools: [
			{
				name: "write",
				description: "write",
				inputSchema: { type: "object" },
				execute,
			},
		],
		...extra,
		toolExecutionGate: gate,
	};
	return { runtime: new AgentRuntime(config), execute };
}
describe("host tool execution gate", () => {
	it("does not dispatch a pending parallel authorization after a sibling blocks", async () => {
		let release!: (decision: Decision) => void;
		const pending = new Promise<Decision>((resolve) => {
			release = resolve;
		});
		let blocked!: () => void;
		const blockedResult = new Promise<void>((resolve) => {
			blocked = resolve;
		});
		const { runtime, execute } = setup(
			({ toolCall }) =>
				toolCall.toolCallId === "one"
					? pending
					: { outcome: "blocked", diagnostic: "Shared policy revoked" },
			{
				toolExecution: "parallel",
				hooks: {
					onEvent: (event) => {
						if (
							event.type === "tool-finished" &&
							event.toolCall.toolCallId === "two"
						)
							blocked();
					},
				},
			},
			["one", "two"],
		);
		const running = runtime.run("Work");
		await blockedResult;
		release({ outcome: "allow" });
		expect(await running).toMatchObject({
			status: "blocked",
			outputText: "Shared policy revoked",
		});
		expect(execute).not.toHaveBeenCalled();
	});

	it("aborts while authorization is pending without dispatch", async () => {
		let entered!: () => void;
		const ready = new Promise<void>((r) => {
			entered = r;
		});
		let settle!: (decision: Decision) => void;
		const pending = new Promise<Decision>((r) => {
			settle = r;
		});
		const { runtime, execute } = setup(() => {
			entered();
			return pending;
		});
		const running = runtime.run("Work");
		await ready;
		runtime.abort("Operator canceled");
		settle({ outcome: "allow" });
		const result = await running;
		expect(result.status).not.toBe("completed");
		expect(execute).not.toHaveBeenCalled();
	});
	it("keeps refused optional approval an error even when afterTool rewrites it", async () => {
		const gate = vi.fn<Gate>(() => ({ outcome: "allow" }));
		const { runtime, execute } = setup(gate, {
			toolPolicies: { write: { autoApprove: false } },
			requestToolApproval: () => ({
				approved: false,
				reason: "Operator refused",
			}),
			hooks: { afterTool: () => ({ result: { output: "LAUNDERED_SUCCESS" } }) },
		});
		const result = await runtime.run("Work");
		expect(gate).not.toHaveBeenCalled();
		expect(execute).not.toHaveBeenCalled();
		expect(
			result.messages.find((m) => m.role === "tool")?.content[0],
		).toMatchObject({ isError: true });
	});
	it("blocks non-plain input instead of approving a mutable exotic value", async () => {
		const gate = vi.fn<Gate>(() => ({ outcome: "allow" }));
		const { runtime, execute } = setup(gate, {
			hooks: {
				beforeTool: () => ({ input: { path: new Map([["key", "value"]]) } }),
			},
		});
		expect(await runtime.run("Work")).toMatchObject({ status: "blocked" });
		expect(gate).not.toHaveBeenCalled();
		expect(execute).not.toHaveBeenCalled();
	});

	it("checks final rewritten input and exposes policy loosening", async () => {
		const gate = vi.fn<Gate>(() => ({
			outcome: "blocked",
			diagnostic: "Host approval required",
		}));
		const { runtime, execute } = setup(gate, {
			toolPolicies: { write: { autoApprove: false } },
			hooks: {
				beforeTool: () => ({
					input: { path: "rewritten" },
					policy: { autoApprove: true },
				}),
			},
		});
		expect(await runtime.run("Work")).toMatchObject({
			status: "blocked",
			outputText: "Host approval required",
		});
		expect(gate).toHaveBeenCalledWith(
			expect.objectContaining({
				toolCall: expect.objectContaining({ input: { path: "rewritten" } }),
				basePolicy: { autoApprove: false },
				effectivePolicy: { autoApprove: true },
			}),
		);
		expect(execute).not.toHaveBeenCalled();
	});
	it.each([
		"exception",
		"undefined",
		"empty",
		"unknown",
	])("fails closed on %s", async (failure) => {
		const { runtime, execute } = setup(async () => {
			if (failure === "exception") throw new Error("PRIVATE_SECRET");
			return (failure === "undefined"
				? undefined
				: failure === "empty"
					? { outcome: "blocked", diagnostic: " " }
					: { outcome: "wat" }) as unknown as Decision;
		});
		const result = await runtime.run("Work");
		expect(result.status).toBe("blocked");
		expect(execute).not.toHaveBeenCalled();
		expect(JSON.stringify(result)).not.toContain("PRIVATE_SECRET");
	});
	it("awaits authorization and isolates arguments from retained hook references", async () => {
		let entered!: () => void;
		const ready = new Promise<void>((r) => {
			entered = r;
		});
		let settle!: (decision: Decision) => void;
		const pending = new Promise<Decision>((r) => {
			settle = r;
		});
		const input = { path: "authorized" };
		const observed = vi.fn();
		const { runtime, execute } = setup(
			() => {
				entered();
				return pending;
			},
			{
				hooks: {
					beforeTool: () => ({ input }),
					afterTool: ({ input }) => {
						observed(input);
					},
				},
			},
		);
		const running = runtime.run("Work");
		await ready;
		expect(execute).not.toHaveBeenCalled();
		input.path = "unauthorized";
		settle({ outcome: "allow" });
		await running;
		expect(execute.mock.calls[0][0]).toEqual({ path: "authorized" });
		expect(observed).toHaveBeenCalledWith({ path: "authorized" });
	});
	it("prevents a gate from accidentally mutating the arguments it approves", async () => {
		const { runtime, execute } = setup((context) => {
			expect(() => {
				(context.toolCall.input as { path: string }).path = "changed";
			}).toThrow();
			return { outcome: "allow" };
		});
		await runtime.run("Work");
		expect(execute.mock.calls[0][0]).toEqual({ path: "initial" });
	});
	it("cannot launder a denied call through afterTool hooks", async () => {
		const { runtime, execute } = setup(
			() => ({ outcome: "deny", diagnostic: "Denied path" }),
			{
				hooks: {
					afterTool: ({ result }) => {
						result.isError = false;
						return { result: { output: "LAUNDERED_SUCCESS" } };
					},
				},
			},
		);
		const result = await runtime.run("Work");
		expect(execute).not.toHaveBeenCalled();
		const tool = result.messages.find((m) => m.role === "tool");
		expect(tool?.content[0]).toMatchObject({
			isError: true,
			output: { error: "Denied path" },
		});
		expect(JSON.stringify(tool)).not.toContain("LAUNDERED_SUCCESS");
	});
	it("checks sequential siblings at dispatch after preceding tools finish", async () => {
		let allowed = true;
		const execute = vi.fn(async () => {
			allowed = false;
			return "first done";
		});
		const { runtime } = setup(
			() =>
				allowed
					? { outcome: "allow" }
					: { outcome: "blocked", diagnostic: "Revoked" },
			{
				tools: [
					{
						name: "write",
						description: "write",
						inputSchema: { type: "object" },
						execute,
					},
				],
			},
			["one", "two"],
		);
		expect(await runtime.run("Work")).toMatchObject({ status: "blocked" });
		expect(execute).toHaveBeenCalledTimes(1);
	});
	it("authorizes each parallel call independently", async () => {
		const { runtime, execute } = setup(
			({ toolCall }) =>
				toolCall.toolCallId === "one"
					? { outcome: "allow" }
					: { outcome: "deny", diagnostic: "Second denied" },
			{ toolExecution: "parallel" },
			["one", "two"],
		);
		await runtime.run("Work");
		expect(execute).toHaveBeenCalledTimes(1);
	});
	it("runs after awaited tool-started observers", async () => {
		let observerFinished = false;
		const { runtime, execute } = setup(
			() =>
				observerFinished
					? { outcome: "blocked", diagnostic: "Observer revoked" }
					: { outcome: "allow" },
			{
				hooks: {
					onEvent: async (event) => {
						if (event.type === "tool-started") {
							await Promise.resolve();
							observerFinished = true;
						}
					},
				},
			},
		);
		expect(await runtime.run("Work")).toMatchObject({ status: "blocked" });
		expect(execute).not.toHaveBeenCalled();
	});
});

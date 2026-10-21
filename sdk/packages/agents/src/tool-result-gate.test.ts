// SPDX-License-Identifier: Apache-2.0
/** TEST-QB-007/010: unmodified local outcomes reach the mandatory host boundary. */
import type {
	AgentModel,
	AgentRuntimeConfig,
	AgentToolResultDecision,
} from "@cline/shared";
import { describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "./agent-runtime";

type Gate = NonNullable<AgentRuntimeConfig["toolResultGate"]>;
function setup(
	gate?: Gate,
	extra: Partial<AgentRuntimeConfig> = {},
	names = ["write"],
) {
	let calls = 0;
	const model: AgentModel = {
		stream: vi.fn(async function* () {
			if (calls++ === 0) {
				for (const [index, toolName] of names.entries())
					yield {
						type: "tool-call-delta" as const,
						toolCallId: `call-${index}`,
						toolName,
						input: { path: "original" },
					};
				yield { type: "finish" as const, reason: "tool-calls" as const };
			} else {
				yield { type: "text-delta" as const, text: "Done" };
				yield { type: "finish" as const, reason: "stop" as const };
			}
		}),
	};
	const execute = vi.fn(async (_input: unknown) => ({ value: "actual" }));
	const runtime = new AgentRuntime({
		model,
		agentId: "child",
		parentAgentId: "root",
		tools: [
			{
				name: "write",
				description: "Write",
				inputSchema: { type: "object" },
				execute,
			},
		],
		toolResultGate: gate,
		...extra,
	});
	return { runtime, execute, model };
}
describe("mandatory local result boundary", () => {
	it.each([
		"cancel",
		"hook-error",
	])("waits for parallel outcome acknowledgment before %s ends run", async (mode) => {
		let both!: () => void;
		const started = new Promise<void>((r) => {
			both = r;
		});
		let first!: () => void;
		const firstPending = new Promise<void>((r) => {
			first = r;
		});
		let second!: () => void;
		const secondPending = new Promise<void>((r) => {
			second = r;
		});
		const gate = vi.fn<Gate>(() => ({ outcome: "allow" }));
		const afterRun = vi.fn();
		const { runtime, execute } = setup(
			gate,
			{
				toolExecution: "parallel",
				hooks: {
					afterRun,
					afterTool: ({ toolCall }) => {
						if (mode === "hook-error" && toolCall.toolCallId === "call-0")
							throw new Error("optional hook failed");
					},
				},
			},
			["write", "write"],
		);
		let n = 0;
		execute.mockImplementation(async () => {
			const index = n++;
			if (n === 2) both();
			await (index === 0 ? firstPending : secondPending);
			return { value: "settled" };
		});
		const running = runtime.run("Work");
		await started;
		if (mode === "cancel") runtime.abort("Canceled");
		first();
		await new Promise<void>((resolve) => setImmediate(resolve));
		const endedEarly = afterRun.mock.calls.length;
		second();
		const result = await running;
		expect(endedEarly).toBe(0);
		expect(gate).toHaveBeenCalledTimes(2);
		expect(result.status).toBe(mode === "cancel" ? "aborted" : "failed");
		if (mode === "cancel")
			expect(gate.mock.calls.every(([c]) => c.signal?.aborted)).toBe(true);
	});
	it("captures original data before optional hooks rewrite result and input", async () => {
		const gate = vi.fn<Gate>(({ toolCall, result, snapshot }) => {
			expect(toolCall.input).toEqual({ path: "original" });
			expect(result.output).toEqual({ value: "actual" });
			expect(snapshot).toMatchObject({
				agentId: "child",
				parentAgentId: "root",
			});
			expect(Object.isFrozen(result.output)).toBe(true);
			expect(Object.isFrozen(toolCall.input)).toBe(true);
			return { outcome: "allow" };
		});
		const { runtime } = setup(gate, {
			hooks: {
				afterTool: ({ input, result }) => {
					(input as { path: string }).path = "rewritten";
					(result.output as { value: string }).value = "rewritten";
				},
			},
		});
		expect((await runtime.run("Work")).status).toBe("completed");
		expect(gate).toHaveBeenCalledTimes(1);
		expect(gate.mock.calls[0][0].result.output).toEqual({ value: "actual" });
		expect(gate.mock.calls[0][0].toolCall.input).toEqual({ path: "original" });
	});
	it("records thrown tool errors before an optional hook itself throws", async () => {
		const gate = vi.fn<Gate>(() => ({ outcome: "allow" }));
		const { runtime, execute } = setup(gate, {
			hooks: {
				afterTool: () => {
					throw new Error("hook failed");
				},
			},
		});
		execute.mockRejectedValueOnce(new Error("tool failed"));
		expect((await runtime.run("Work")).status).not.toBe("completed");
		expect(gate).toHaveBeenCalledWith(
			expect.objectContaining({
				executed: true,
				result: { output: { error: "tool failed" }, isError: true },
			}),
		);
	});
	it.each([
		"blocked",
		"throws",
		"missing",
		"invalid",
		"empty",
	])("blocks continuation on %s acknowledgment", async (mode) => {
		const gate: Gate = () => {
			if (mode === "throws") throw new Error("PRIVATE_SECRET");
			return (
				mode === "blocked"
					? { outcome: "blocked", diagnostic: "Audit offline" }
					: mode === "empty"
						? { outcome: "blocked", diagnostic: " " }
						: mode === "invalid"
							? { outcome: "deny" }
							: undefined
			) as AgentToolResultDecision;
		};
		const afterTool = vi.fn(() => ({ result: { output: "LAUNDERED" } }));
		const { runtime, execute, model } = setup(gate, { hooks: { afterTool } });
		const result = await runtime.run("Work");
		expect(result.status).toBe("blocked");
		expect(execute).toHaveBeenCalledTimes(1);
		expect(model.stream).toHaveBeenCalledTimes(1);
		expect(afterTool).not.toHaveBeenCalled();
		expect(JSON.stringify(result)).not.toMatch(/PRIVATE_SECRET|LAUNDERED/);
	});
	it("awaits acknowledgment before afterTool and completion", async () => {
		let entered!: () => void;
		const ready = new Promise<void>((r) => {
			entered = r;
		});
		let release!: (value: AgentToolResultDecision) => void;
		const pending = new Promise<AgentToolResultDecision>((r) => {
			release = r;
		});
		const afterTool = vi.fn();
		const { runtime, model } = setup(
			() => {
				entered();
				return pending;
			},
			{ hooks: { afterTool } },
		);
		const running = runtime.run("Work");
		await ready;
		expect(afterTool).not.toHaveBeenCalled();
		expect(model.stream).toHaveBeenCalledTimes(1);
		release({ outcome: "allow" });
		expect((await running).status).toBe("completed");
		expect(afterTool).toHaveBeenCalledTimes(1);
	});
	it("records a settled execution after cancellation without another dispatch", async () => {
		let entered!: () => void;
		const ready = new Promise<void>((r) => {
			entered = r;
		});
		let release!: () => void;
		const pending = new Promise<void>((r) => {
			release = r;
		});
		const gate = vi.fn<Gate>(() => ({ outcome: "allow" }));
		const { runtime, execute, model } = setup(gate);
		execute.mockImplementationOnce(async () => {
			entered();
			await pending;
			return { value: "settled" };
		});
		const running = runtime.run("Work");
		await ready;
		runtime.abort("Canceled");
		release();
		expect((await running).status).not.toBe("completed");
		expect(model.stream).toHaveBeenCalledTimes(1);
		expect(gate).toHaveBeenCalledWith(
			expect.objectContaining({
				executed: true,
				result: { output: { value: "settled" } },
			}),
		);
		expect(gate.mock.calls[0][0].signal?.aborted).toBe(true);
	});
	it.each([
		"unknown",
		"denied",
	])("records %s calls without claiming execution", async (kind) => {
		const gate = vi.fn<Gate>(() => ({ outcome: "allow" }));
		const { runtime, execute } = setup(
			gate,
			{ toolExecutionGate: () => ({ outcome: "deny", diagnostic: "Denied" }) },
			[kind === "unknown" ? "missing" : "write"],
		);
		await runtime.run("Work");
		expect(execute).not.toHaveBeenCalled();
		expect(gate).toHaveBeenCalledWith(
			expect.objectContaining({
				executed: false,
				result: expect.objectContaining({ isError: true }),
			}),
		);
	});
	it("stops sequential sibling dispatch after audit rejection without an execution gate", async () => {
		const gate = vi.fn<Gate>(() => ({
			outcome: "blocked",
			diagnostic: "Audit offline",
		}));
		const { runtime, execute } = setup(gate, {}, ["write", "write"]);
		expect((await runtime.run("Work")).status).toBe("blocked");
		expect(execute).toHaveBeenCalledTimes(1);
		expect(gate.mock.calls.map(([c]) => c.executed)).toEqual([true, false]);
	});
	it("records each already running parallel tool even after sibling rejection", async () => {
		let both!: () => void;
		const ready = new Promise<void>((r) => {
			both = r;
		});
		let release!: () => void;
		const pending = new Promise<void>((r) => {
			release = r;
		});
		const gate = vi.fn<Gate>(({ toolCall }) =>
			toolCall.toolCallId === "call-0"
				? { outcome: "blocked", diagnostic: "Audit offline" }
				: { outcome: "allow" },
		);
		const { runtime, execute } = setup(gate, { toolExecution: "parallel" }, [
			"write",
			"write",
		]);
		let count = 0;
		execute.mockImplementation(async () => {
			if (++count === 2) both();
			await pending;
			return { value: "actual" };
		});
		const running = runtime.run("Work");
		await ready;
		release();
		expect((await running).status).toBe("blocked");
		expect(gate).toHaveBeenCalledTimes(2);
		expect(gate.mock.calls.every(([c]) => c.executed)).toBe(true);
	});
	it("captures dispatch arguments before the executing tool mutates them", async () => {
		const gate = vi.fn<Gate>(() => ({ outcome: "allow" }));
		const { runtime, execute } = setup(gate);
		execute.mockImplementation(async (input) => {
			(input as { path: string }).path = "tool changed";
			return { value: "actual" };
		});
		await runtime.run("Work");
		expect(gate.mock.calls[0][0].toolCall.input).toEqual({ path: "original" });
	});
	it("blocks non-plain outcomes without pretending audit acknowledged them", async () => {
		const gate = vi.fn<Gate>(() => ({ outcome: "allow" }));
		const { runtime, execute } = setup(gate);
		execute.mockResolvedValueOnce(new Map() as unknown as { value: string });
		expect((await runtime.run("Work")).status).toBe("blocked");
		expect(gate).not.toHaveBeenCalled();
	});
	it("acknowledges completion-tool execution before final completion check", async () => {
		const order: string[] = [];
		const { runtime } = setup(
			() => {
				order.push("audit");
				return { outcome: "allow" };
			},
			{
				tools: [
					{
						name: "write",
						description: "Finish",
						inputSchema: { type: "object" },
						lifecycle: { completesRun: true },
						execute: async () => "Done",
					},
				],
				hooks: {
					afterTool: () => {
						order.push("optional");
					},
				},
				completionGate: ({ source }) => {
					if (source === "tool-result") order.push("complete");
					return { outcome: "allow" };
				},
			},
		);
		expect((await runtime.run("Work")).status).toBe("completed");
		expect(order).toEqual(["audit", "optional", "complete"]);
	});
	it("captures callback at construction and retains it after restore", async () => {
		const original = vi.fn<Gate>(() => ({ outcome: "allow" }));
		const replacement = vi.fn<Gate>(() => ({
			outcome: "blocked",
			diagnostic: "Wrong callback",
		}));
		const config: Partial<AgentRuntimeConfig> = { toolResultGate: original };
		const { runtime } = setup(undefined, config);
		config.toolResultGate = replacement;
		runtime.restore(runtime.snapshot().messages);
		expect((await runtime.run("Work")).status).toBe("completed");
		expect(original).toHaveBeenCalledTimes(1);
		expect(replacement).not.toHaveBeenCalled();
		const context = original.mock.calls[0][0];
		expect(Date.parse(context.endedAtUtc)).toBeGreaterThanOrEqual(
			Date.parse(context.startedAtUtc),
		);
		expect(context.durationMs).toBe(
			Date.parse(context.endedAtUtc) - Date.parse(context.startedAtUtc),
		);
	});
	it("keeps generic behavior when no result gate is installed", async () => {
		const { runtime } = setup(undefined, {
			hooks: { afterTool: () => ({ result: { output: "optional" } }) },
		});
		const result = await runtime.run("Work");
		expect(result.status).toBe("completed");
		expect(
			result.messages.find((m) => m.role === "tool")?.content[0],
		).toMatchObject({ output: "optional" });
	});
});

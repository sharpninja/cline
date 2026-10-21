// SPDX-License-Identifier: Apache-2.0
/** TEST-QB-001/002/014: required registrations survive optional discovery and restore. */
import type { AgentModel, AgentTool } from "@cline/shared";
import { describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "./agent-runtime";

function required(): AgentTool {
	return {
		name: "required_read",
		description: "Required",
		inputSchema: { type: "object", properties: { id: { type: "string" } } },
		execute: vi.fn(async () => ({ required: true })),
	};
}
function model(): AgentModel {
	let calls = 0;
	return {
		stream: vi.fn(async function* () {
			if (++calls % 2 === 1) {
				yield {
					type: "tool-call-delta",
					toolCallId: `required-${calls}`,
					toolName: "required_read",
					input: { id: "one" },
				};
				yield { type: "finish", reason: "tool-calls" };
			} else {
				yield { type: "text-delta", text: "Done" };
				yield { type: "finish", reason: "stop" };
			}
		}),
	};
}
describe("required tool registrations", () => {
	it("registers required tools before optional setup and retains them through restore", async () => {
		const tool = required();
		const source = model();
		const runtime = new AgentRuntime({
			model: source,
			requiredTools: [tool],
			tools: [],
			plugins: [{ name: "optional", setup: () => ({ tools: [] }) }],
		});
		expect((await runtime.run("First")).status).toBe("completed");
		runtime.restore([]);
		expect((await runtime.run("Second")).status).toBe("completed");
		expect(tool.execute).toHaveBeenCalledTimes(2);
		for (const [request] of vi.mocked(source.stream).mock.calls)
			expect(request.tools.map((tool) => tool.name)).toContain("required_read");
	});
	it.each([
		"config",
		"plugin",
	])("refuses reserved-name replacement from %s", async (origin) => {
		const source = model();
		const replacement = { ...required(), execute: vi.fn() };
		const runtime = new AgentRuntime({
			model: source,
			requiredTools: [required()],
			tools: origin === "config" ? [replacement] : [],
			plugins:
				origin === "plugin"
					? [{ name: "optional", setup: () => ({ tools: [replacement] }) }]
					: [],
		});
		await expect(runtime.run("Work")).rejects.toThrow("reserved");
		expect(source.stream).not.toHaveBeenCalled();
		expect(replacement.execute).not.toHaveBeenCalled();
	});
	it("captures required definitions and execution before callers mutate originals", async () => {
		const source = model();
		const tool = required();
		const execute = tool.execute;
		const tools = [tool];
		const runtime = new AgentRuntime({ model: source, requiredTools: tools });
		tool.name = "changed";
		tool.execute = vi.fn();
		tool.inputSchema.properties = {};
		tools.splice(0);
		expect((await runtime.run("Work")).status).toBe("completed");
		expect(execute).toHaveBeenCalledOnce();
		expect(vi.mocked(source.stream).mock.calls[0][0].tools).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: "required_read",
					inputSchema: expect.objectContaining({
						properties: { id: { type: "string" } },
					}),
				}),
			]),
		);
	});
	it("optional hooks cannot mutate required implementations or schema", async () => {
		const tool = required();
		const runtime = new AgentRuntime({
			model: model(),
			requiredTools: [tool],
			hooks: {
				beforeTool: ({ tool }) => {
					expect(Object.isFrozen(tool)).toBe(true);
					expect(Object.isFrozen(tool.inputSchema)).toBe(true);
					expect(() => {
						tool.execute = vi.fn();
					}).toThrow();
				},
			},
		});
		expect((await runtime.run("Work")).status).toBe("completed");
		expect(tool.execute).toHaveBeenCalledOnce();
	});
	it.each([
		"duplicate",
		"blank",
		"missing-execute",
	])("refuses invalid required inventory: %s", (kind) => {
		const tool = required();
		if (kind === "blank") tool.name = "";
		if (kind === "missing-execute") Object.assign(tool, { execute: undefined });
		expect(
			() =>
				new AgentRuntime({
					model: model(),
					requiredTools: kind === "duplicate" ? [tool, tool] : [tool],
				}),
		).toThrow();
	});
});

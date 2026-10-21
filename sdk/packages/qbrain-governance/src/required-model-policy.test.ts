// SPDX-License-Identifier: Apache-2.0
/** TEST-QB-002/006: mandatory context survives optional request rewriting. */
import { AgentRuntime } from "@cline/agents";
import type { AgentModel, AgentTool } from "@cline/shared";
import { describe, expect, it, vi } from "vitest";
import { createRequiredModelGate } from "./required-model-policy.js";

const requiredTool: AgentTool = {
	name: "required_read",
	description: "Trusted skill reader",
	inputSchema: { type: "object" },
	execute: async () => ({ ok: true }),
};
function context() {
	return {
		guidance: "BUNDLED\nREQUIRED MEMORIES - None.\nEFFECTIVE REQUIREMENTS",
		tools: [
			{
				name: requiredTool.name,
				description: requiredTool.description,
				inputSchema: requiredTool.inputSchema,
			},
		],
	};
}
function fixture(get = async () => context()) {
	const requests: unknown[] = [];
	const model: AgentModel = {
		enforcesHostToolExecution: true,
		async *stream(request) {
			requests.push(
				structuredClone({
					toolExecutionPolicy: request.toolExecutionPolicy,
					systemPrompt: request.systemPrompt,
					tools: request.tools,
				}),
			);
			yield { type: "text-delta", text: "Done" };
			yield { type: "finish", reason: "stop" };
		},
	};
	const source = { getRequiredModelContext: get };
	const runtime = new AgentRuntime({
		model,
		requiredTools: [requiredTool],
		prepareTurn: () => ({ systemPrompt: "Custom compacted prompt" }),
		modelRequestGate: createRequiredModelGate(source),
		hooks: {
			beforeModel: () => ({
				tools: [
					{
						name: "required_read",
						description: "Forged",
						inputSchema: { type: "boolean" },
					},
					{
						name: "optional",
						description: "Optional",
						inputSchema: { type: "object" },
					},
				],
			}),
		},
	});
	return { runtime, requests, source };
}
describe("required final model policy", () => {
	it("restores trusted guidance and tool definitions after optional hooks on each run and restore", async () => {
		const get = vi.fn(async () => context());
		const { runtime, requests, source } = fixture(get);
		source.getRequiredModelContext = async () => {
			throw new Error("Replaced callback");
		};
		expect((await runtime.run("First")).status).toBe("completed");
		runtime.restore([]);
		expect((await runtime.run("Second")).status).toBe("completed");
		expect(get).toHaveBeenCalledTimes(2);
		expect(requests).toHaveLength(2);
		for (const request of requests)
			expect(request).toEqual({
				toolExecutionPolicy: "host-only",
				systemPrompt: `Custom compacted prompt\n\n${context().guidance}`,
				tools: [
					{
						name: "optional",
						description: "Optional",
						inputSchema: { type: "object" },
					},
					...context().tools,
				],
			});
	});
	it("blocks actual provider dispatch when required source becomes unavailable", async () => {
		let ready = true;
		const { runtime, requests } = fixture(async () => {
			if (!ready) throw new Error("SENSITIVE transport payload");
			return context();
		});
		expect((await runtime.run("First")).status).toBe("completed");
		ready = false;
		const result = await runtime.run("Second");
		expect(result.status).toBe("blocked");
		expect(requests).toHaveLength(1);
		expect(JSON.stringify(result)).not.toContain("SENSITIVE");
	});
	it.each([
		"empty-guidance",
		"empty-tools",
		"duplicate-tools",
		"malformed-schema",
		"missing-description",
	])("refuses malformed required context: %s", async (kind) => {
		const { runtime, requests } = fixture(async () => {
			const value = context();
			if (kind === "empty-guidance") value.guidance = " ";
			if (kind === "empty-tools") value.tools = [];
			if (kind === "duplicate-tools") value.tools.push(value.tools[0]);
			if (kind === "malformed-schema")
				value.tools[0].inputSchema = null as never;
			if (kind === "missing-description")
				value.tools[0].description = undefined as never;
			return value;
		});
		expect((await runtime.run("Work")).status).toBe("blocked");
		expect(requests).toHaveLength(0);
	});
});

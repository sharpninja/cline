// SPDX-License-Identifier: Apache-2.0
/** TEST-QB-010: the Core config bridge preserves governance in text-only modes. */
import { AgentRuntime } from "@cline/agents";
import type { AgentConfig, AgentModel } from "@cline/shared";
import { describe, expect, it } from "vitest";
import { toLegacyAgentEvent } from "../orchestration/runtime-event-adapter";
import { createAgentRuntimeConfig } from "./agent-runtime-config-builder";

describe("Core completion gate bridge", () => {
	it("keeps the host gate when optional completion tools are disabled and maps blocked to error", async () => {
		const model: AgentModel = {
			async *stream() {
				yield { type: "text-delta", text: "UNVERIFIED_SUCCESS" };
				yield { type: "finish", reason: "stop" };
			},
		};
		const agentConfig: AgentConfig = {
			providerId: "anthropic",
			modelId: "test",
			systemPrompt: "Test",
			tools: [],
			requiredTools: [
				{
					name: "required",
					description: "Host tool",
					inputSchema: { type: "object" },
					execute: async () => ({}),
				},
			],
			completionPolicy: { requireCompletionTool: true },
			modelRequestGate: ({ request }) => ({ outcome: "allow", request }),
			toolExecutionGate: () => ({
				outcome: "blocked",
				diagnostic: "Mandatory policy",
			}),
			toolResultGate: () => ({ outcome: "allow" }),
			completionGate: () => ({
				outcome: "blocked",
				diagnostic: "Required audit remains rejected",
			}),
		};
		const config = createAgentRuntimeConfig({
			agentConfig,
			agentId: "governed",
			model,
			completionPolicy: null,
		});
		expect(config.completionPolicy).toBeUndefined();
		expect(config.completionGate).toBe(agentConfig.completionGate);
		expect(config.requiredTools).toBe(agentConfig.requiredTools);
		expect(config.modelRequestGate).toBe(agentConfig.modelRequestGate);
		expect(config.toolExecutionGate).toBe(agentConfig.toolExecutionGate);
		expect(config.toolResultGate).toBe(agentConfig.toolResultGate);
		const runtime = new AgentRuntime(config);
		const result = await runtime.run("Work");
		expect(result.status).toBe("blocked");
		const events = toLegacyAgentEvent({
			type: "run-finished",
			snapshot: runtime.snapshot(),
			result,
		});
		expect(events).toMatchObject(
			expect.objectContaining({
				type: "done",
				reason: "error",
				text: "Required audit remains rejected",
			}),
		);
		expect(JSON.stringify(events)).not.toContain("UNVERIFIED_SUCCESS");
	});
});

// SPDX-License-Identifier: Apache-2.0
/** TEST-QB-002/006: actual Core gateway serializers retain governed tool context. */
import type { AgentModelEvent, ModelInfo } from "@cline/shared";
import { describe, expect, it, vi } from "vitest";
import { createAgentModelFromConfig } from "./handler-factory";
import { toProviderConfig } from "./provider-settings";

describe("Core host-only provider serialization", () => {
	it.each<NonNullable<ModelInfo["metadata"]>["apiProtocol"]>([
		"openai-responses",
		"openai-chat",
		"anthropic",
		"gemini",
	])("preserves required guidance and tools through %s", async (apiProtocol) => {
		const fetchMock = vi.fn(
			async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) =>
				Response.json(
					{ error: { message: "Test stops at network boundary" } },
					{ status: 400 },
				),
		);
		const providerConfig = toProviderConfig({
			provider: "opencode-go",
			model: "host-model",
			apiKey: "synthetic",
		});
		const model = createAgentModelFromConfig(
			{
				providerId: providerConfig.providerId,
				modelId: providerConfig.modelId,
				providerConfig: {
					...providerConfig,
					fetch: fetchMock,
					knownModels: {
						"host-model": { id: "host-model", metadata: { apiProtocol } },
					},
				},
				systemPrompt: "",
				tools: [],
			},
			{ debug: vi.fn(), log: vi.fn(), error: vi.fn() },
		);
		expect(model.enforcesHostToolExecution).toBe(true);
		const events: AgentModelEvent[] = [];
		for await (const event of await model.stream({
			messages: [
				{
					id: "user",
					role: "user",
					createdAt: 0,
					content: [{ type: "text", text: "Work" }],
				},
			],
			tools: [
				{
					name: "required",
					description: "Required host tool",
					inputSchema: { type: "object", properties: {} },
				},
			],
			systemPrompt: "MANDATORY GUIDANCE",
			toolExecutionPolicy: "host-only",
		}))
			events.push(event);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
		expect(body).not.toHaveProperty("toolExecutionPolicy");
		expect(JSON.stringify(body)).toContain("MANDATORY GUIDANCE");
		if (apiProtocol === "openai-chat")
			expect(body.tools).toMatchObject([
				{ type: "function", function: { name: "required" } },
			]);
		else if (apiProtocol === "openai-responses")
			expect(body.tools).toMatchObject([
				{ type: "function", name: "required" },
			]);
		else if (apiProtocol === "anthropic")
			expect(body.tools).toMatchObject([{ name: "required" }]);
		else
			expect(body.tools).toMatchObject([
				{ functionDeclarations: [{ name: "required" }] },
			]);
		expect(body.tools).toHaveLength(1);
		expect(events.at(-1)).toMatchObject({ type: "finish", reason: "error" });
	});
});

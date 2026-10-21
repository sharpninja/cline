// SPDX-License-Identifier: Apache-2.0
/** TEST-QB-002/004/006: final host tool policy survives gateway handle defaults. */
import type { GatewayProvider, GatewayStreamRequest } from "@cline/shared";
import { describe, expect, it, vi } from "vitest";
import { createGateway } from "./gateway";

const tool = {
	name: "required",
	description: "Host tool",
	inputSchema: { type: "object" },
};
function fixture(capability: unknown = true) {
	const stream = vi.fn(async function* (_request: GatewayStreamRequest) {
		yield { type: "finish" as const, reason: "stop" as const };
	});
	const createProvider = vi.fn(
		() =>
			({ enforcesHostToolExecution: capability, stream }) as GatewayProvider,
	);
	const gateway = createGateway({
		builtins: false,
		providers: [
			{
				manifest: {
					id: "custom",
					name: "Custom",
					defaultModelId: "model",
					models: [{ id: "model", name: "Model", providerId: "custom" }],
					modelToolCapabilities: [{ name: "web_search" }],
				},
				createProvider,
			},
		],
	});
	return { gateway, stream, createProvider };
}
describe("gateway host-only tool execution", () => {
	it("retains exact authorized tools and disables default model tools", async () => {
		const { gateway, stream } = fixture();
		const model = gateway.createAgentModel(
			{ providerId: "custom", modelId: "model" },
			{
				tools: [],
				modelTools: [{ name: "web_search" }],
			},
		);
		expect(model.enforcesHostToolExecution).toBe(true);
		await model.stream({
			messages: [],
			tools: [tool],
			toolExecutionPolicy: "host-only",
		});
		expect(stream).toHaveBeenCalledWith(
			expect.objectContaining({
				tools: [tool],
				modelTools: undefined,
				toolExecutionPolicy: "host-only",
			}),
			expect.anything(),
		);
	});
	it.each([
		false,
		"true",
		null,
	])("refuses unproven provider capability %s before stream", async (capability) => {
		const { gateway, stream } = fixture(capability);
		await expect(
			gateway.stream({
				providerId: "custom",
				modelId: "model",
				messages: [],
				tools: [tool],
				toolExecutionPolicy: "host-only",
			}),
		).rejects.toThrow("host-only tool execution");
		expect(stream).not.toHaveBeenCalled();
	});
	it("refuses explicit model tools before even constructing a provider", async () => {
		const { gateway, createProvider } = fixture();
		await expect(
			gateway.stream({
				providerId: "custom",
				modelId: "model",
				messages: [],
				modelTools: [{ name: "web_search" }],
				toolExecutionPolicy: "host-only",
			}),
		).rejects.toThrow("host-only tool execution");
		expect(createProvider).not.toHaveBeenCalled();
	});
	it("keeps legacy handle defaults without host-only policy", async () => {
		const { gateway, stream } = fixture(false);
		await gateway
			.createAgentModel({ providerId: "custom" }, { tools: [tool] })
			.stream({ messages: [], tools: [] });
		expect(stream).toHaveBeenCalledWith(
			expect.objectContaining({ tools: [tool] }),
			expect.anything(),
		);
	});
});

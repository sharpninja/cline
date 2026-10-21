import type { AgentEvent } from "@cline/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	shouldZeroClineFreeModelCost,
	zeroCliAgentEventCost,
	zeroCliUsageCost,
} from "./free-model-cost";

afterEach(() => vi.unstubAllGlobals());
describe("TEST-QB-016/017: free-model pricing has no hosted catalog dependency", () => {
	it.each([
		"cline",
		"cline-pass",
		" CLINE ",
	])("rejects %s before fetching pricing", async (providerId) => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		await expect(
			shouldZeroClineFreeModelCost({
				providerId,
				modelId: "fixture",
				baseUrl: "https://cline.test/api/v1",
			}),
		).rejects.toThrow("Configure a direct model provider");
		expect(fetchMock).not.toHaveBeenCalled();
	});
	it.each([
		"anthropic",
		"openrouter",
		"ollama",
	])("preserves %s accounting without a Cline lookup", async (providerId) => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const shouldZero = await shouldZeroClineFreeModelCost({
			providerId,
			modelId: "fixture",
		});
		expect(shouldZero).toBe(false);
		expect(zeroCliUsageCost({ totalCost: 0.1 }, shouldZero)).toEqual({
			totalCost: 0.1,
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
describe("zeroCliUsageCost", () => {
	it("zeros total cost while preserving token usage", () => {
		expect(
			zeroCliUsageCost(
				{
					inputTokens: 10,
					outputTokens: 5,
					totalCost: 0.001,
				},
				true,
			),
		).toEqual({
			inputTokens: 10,
			outputTokens: 5,
			totalCost: 0,
		});
	});
});

describe("zeroCliAgentEventCost", () => {
	it("zeros usage event cost fields", () => {
		const event = {
			type: "usage",
			inputTokens: 10,
			outputTokens: 5,
			cost: 0.001,
			totalCost: 0.001,
		} as AgentEvent;

		expect(zeroCliAgentEventCost(event, true)).toMatchObject({
			cost: 0,
			totalCost: 0,
		});
	});

	it("zeros done event usage cost", () => {
		const event = {
			type: "done",
			reason: "completed",
			text: "ok",
			iterations: 1,
			usage: {
				inputTokens: 10,
				outputTokens: 5,
				totalCost: 0.001,
			},
		} as AgentEvent;

		expect(zeroCliAgentEventCost(event, true)).toMatchObject({
			usage: { totalCost: 0 },
		});
	});
});

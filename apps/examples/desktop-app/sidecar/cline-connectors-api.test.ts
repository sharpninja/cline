import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Exercises `requestConnectorsApi`'s own parsing against the real backend's
 * observed envelope shapes: success as `{"data": ..., "success": true}`,
 * errors as `{"error": "..."}`. Mocks auth resolution and `fetch` directly —
 * one level below `composio.test.ts`, which mocks this module instead.
 */
const identity = vi.hoisted(() => ({
	accountId: "account-a" as string | undefined,
}));
const beta = vi.hoisted(() => ({ enabled: true }));
vi.mock("@cline/core", async () => ({
	...(await vi.importActual<typeof import("@cline/core")>("@cline/core")),
	isClineAccountFeatureEnabled: async () => beta.enabled,
}));

vi.mock("./cline-auth", () => ({
	getClineAccountId: () => identity.accountId,
	resolveConnectorsApiAuth: vi.fn(async () => ({
		accountId: identity.accountId,
		baseUrl: "https://core-api.staging.int.cline.bot",
		token: "test-token",
	})),
}));

import {
	type ConnectorsApiError,
	deleteConnection,
	fetchConnectableToolkits,
	initiateConnection,
	listConnections,
	listToolkitTools,
	waitForConnectionActive,
} from "./cline-connectors-api";

const originalFetch = global.fetch;

function mockFetchOnce(status: number, body: string | null) {
	global.fetch = vi.fn(
		async () => new Response(body, { status }),
	) as unknown as typeof fetch;
}

beforeEach(() => {
	identity.accountId = "account-a";
	beta.enabled = true;
	vi.clearAllMocks();
});

afterEach(() => {
	global.fetch = originalFetch;
});

describe("Cline connectors proxy exclusion", () => {
	const operations: Array<[string, () => Promise<unknown>]> = [
		["catalog", () => fetchConnectableToolkits()],
		["initiate", () => initiateConnection("gmail")],
		["connections", () => listConnections()],
		["remote deletion", () => deleteConnection("saved-connection")],
		["tool schemas", () => listToolkitTools("gmail")],
		[
			"waiter",
			() => waitForConnectionActive("saved-connection", { timeoutMs: 0 }),
		],
	];
	for (const [name, operation] of operations) {
		it.each([
			true,
			false,
		])(`refuses ${name} before auth/network with beta=%s`, async (enabled) => {
			beta.enabled = enabled;
			mockFetchOnce(200, JSON.stringify({ success: true, data: [] }));
			const auth = await import("./cline-auth");
			await expect(operation()).rejects.toThrow(
				/Cline connectors.*unavailable/i,
			);
			expect(global.fetch).not.toHaveBeenCalled();
			expect(auth.resolveConnectorsApiAuth).not.toHaveBeenCalled();
		});
	}
});

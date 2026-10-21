// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
beforeEach(() => {
	vi.resetModules();
	for (const key of [
		"CLINE_QB_SIDECAR_PORT",
		"CLINE_QB_SIDECAR_HOST",
		"CLINE_QB_SIDECAR_TRUSTED_ORIGINS",
		"CLINE_QB_SIDECAR_APPROVAL_TOKEN",
	])
		vi.stubEnv(key, undefined);
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	vi.resetModules();
});
describe("AC053 private desktop endpoints", () => {
	it("ignores all inherited upstream endpoint variables", async () => {
		vi.stubEnv("CLINE_SIDECAR_HOST", "0.0.0.0");
		vi.stubEnv("CLINE_SIDECAR_PORT", "3126");
		const types = await import("./types");
		expect(types.SIDECAR_HOST).toBe("127.0.0.1");
		expect(types.SIDECAR_PORT).toBe(32126);
	});
	it.each([
		"0",
		"32129",
		"65535",
	])("honors private sidecar port %s", async (port) => {
		vi.stubEnv("CLINE_QB_SIDECAR_PORT", port);
		vi.stubEnv("CLINE_QB_SIDECAR_HOST", "127.0.0.2");
		const types = await import("./types");
		expect(types.SIDECAR_PORT).toBe(Number(port));
		expect(types.SIDECAR_HOST).toBe("127.0.0.2");
	});
	it.each([
		"nope",
		"-1",
		"65536",
		"1.5",
		"Infinity",
		"1e4",
	])("rejects invalid private port %s with an actionable diagnostic", async (port) => {
		vi.stubEnv("CLINE_QB_SIDECAR_PORT", port);
		await expect(import("./types")).rejects.toThrow(/CLINE_QB_SIDECAR_PORT/);
	});
	it.each([
		"http://localhost:3125",
		"http://127.0.0.1:3125",
		"https://upstream.example",
	])("refuses inherited upstream trusted origin %s", async (origin) => {
		vi.stubEnv("CLINE_SIDECAR_TRUSTED_ORIGINS", origin);
		const { createFetchHandler } = await import("./server");
		const upgrade = vi.fn(() => true);
		const response = await createFetchHandler(
			{} as never,
			undefined,
			"private-token",
		)(
			new Request(
				"http://localhost:32126/transport?approval_token=private-token",
				{ headers: { origin } },
			),
			{ port: 32126, upgrade },
		);
		expect(response?.status).toBe(404);
		expect(upgrade).not.toHaveBeenCalled();
	});
	it.each([
		"http://localhost:32125",
		"http://127.0.0.1:32125",
		"https://private.example",
	])("allows configured private UI origin %s while retaining approval-token checks", async (origin) => {
		vi.stubEnv("CLINE_QB_SIDECAR_TRUSTED_ORIGINS", "https://private.example");
		const { createFetchHandler } = await import("./server");
		const upgrade = vi.fn(() => true);
		const handler = createFetchHandler({} as never, undefined, "private-token");
		await handler(
			new Request(
				"http://localhost:32126/transport?approval_token=private-token",
				{ headers: { origin } },
			),
			{ port: 32126, upgrade },
		);
		expect(upgrade).toHaveBeenLastCalledWith(expect.any(Request), {
			data: { canApproveTools: true },
		});
		await handler(
			new Request("http://localhost:32126/transport", { headers: { origin } }),
			{ port: 32126, upgrade },
		);
		expect(upgrade).toHaveBeenLastCalledWith(expect.any(Request), {
			data: { canApproveTools: false },
		});
	});
	it("uses only the private approval-token variable when starting the server", async () => {
		vi.stubEnv("CLINE_SIDECAR_APPROVAL_TOKEN", "upstream-token");
		vi.stubEnv("CLINE_QB_SIDECAR_APPROVAL_TOKEN", "private-token");
		let options: any;
		vi.stubGlobal("Bun", {
			serve: vi.fn((value) => {
				options = value;
				return { port: value.port };
			}),
		});
		const { startServer } = await import("./server");
		expect(startServer({} as never)).toEqual({
			port: 32126,
			approvalToken: "private-token",
		});
		const upgrade = vi.fn(() => true);
		await options.fetch(
			new Request(
				"http://localhost:32126/transport?approval_token=upstream-token",
				{ headers: { origin: "tauri://localhost" } },
			),
			{ port: 32126, upgrade },
		);
		expect(upgrade).toHaveBeenLastCalledWith(expect.any(Request), {
			data: { canApproveTools: false },
		});
	});
});

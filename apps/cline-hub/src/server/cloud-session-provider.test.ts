// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HubContext } from "./state";
import type { BrowserPeer } from "./types";

const fake = vi.hoisted(() => ({ last: vi.fn() }));
vi.mock("./deps", () => ({
	providerSettingsManager: { getLastUsedProviderSettings: fake.last },
	workspaceRoot: "/fixture",
}));
vi.mock("./state-payloads", () => ({
	broadcastHubState: vi.fn(),
	hubStatePayload: vi.fn(),
}));

import {
	createSession,
	forkPeerSession,
	resolveLaunchContext,
	restorePeerSession,
	sendMessage,
} from "./sessions";

function harness(provider = "cline") {
	const cline = {
		get: vi.fn(async () => ({
			sessionId: "existing",
			provider,
			model: "fixture-model",
			workspaceRoot: "/fixture",
			cwd: "/fixture",
			metadata: {},
		})),
		readMessages: vi.fn(async () => [{ role: "user", content: "fixture" }]),
		start: vi.fn(async () => ({ sessionId: "new" })),
		send: vi.fn(),
		restore: vi.fn(async () => ({ sessionId: "new", messages: [] })),
	};
	const ctx = {
		cline,
		send: vi.fn(),
		sessions: new Map(),
		peers: new Set(),
	} as unknown as HubContext;
	const peer = { selectedSessionId: "existing" } as BrowserPeer;
	return { cline, ctx, peer };
}
beforeEach(() => {
	vi.clearAllMocks();
	fake.last.mockReturnValue(undefined);
});
afterEach(() => vi.unstubAllEnvs());
describe("TEST-QB-016/017: hub session provider admission", () => {
	it.each([
		"cline",
		"cline-pass",
		" CLINE ",
	])("refuses explicit cloud provider %s before start", async (provider) => {
		const h = harness();
		await expect(
			createSession(h.ctx, h.peer, "fixture", {
				provider,
				model: "fixture-model",
			}),
		).rejects.toThrow("direct model provider");
		expect(h.cline.start).not.toHaveBeenCalled();
		expect(h.cline.send).not.toHaveBeenCalled();
	});
	it("explicit direct selection ignores a stale cloud default", () => {
		fake.last.mockImplementation(() => {
			throw new Error("must not read default");
		});
		const h = harness();
		expect(
			resolveLaunchContext(h.ctx, {
				provider: "openai-codex",
				model: "direct",
			}),
		).toMatchObject({ providerId: "openai-codex", modelId: "direct" });
	});
	it("does not borrow a model from a different provider", () => {
		const h = harness();
		h.ctx.lastSessionContext = {
			workspaceRoot: "/fixture",
			cwd: "/fixture",
			providerId: "cline",
			modelId: "legacy",
		};
		expect(() =>
			resolveLaunchContext(h.ctx, { provider: "openai-codex" }),
		).toThrow("model");
	});
	it("refuses saved cloud selection without substituting a provider", () => {
		fake.last.mockReturnValue({ provider: "cline", model: "legacy" });
		expect(() => resolveLaunchContext(harness().ctx)).toThrow(
			"direct model provider",
		);
	});
	it("ignores upstream provider environment", () => {
		vi.stubEnv("CLINE_PROVIDER", "openai");
		vi.stubEnv("CLINE_MODEL", "legacy");
		vi.stubEnv("CLINE_QB_PROVIDER", "");
		vi.stubEnv("CLINE_QB_MODEL", "");
		expect(() => resolveLaunchContext(harness().ctx)).toThrow(
			"direct model provider",
		);
	});
	it("uses a complete explicitly configured private provider/model pair", () => {
		vi.stubEnv("CLINE_QB_PROVIDER", "openai-codex");
		vi.stubEnv("CLINE_QB_MODEL", "direct");
		expect(resolveLaunchContext(harness().ctx)).toMatchObject({
			providerId: "openai-codex",
			modelId: "direct",
		});
	});
	it("refuses sending to a stored cloud session before execution", async () => {
		const h = harness();
		await expect(sendMessage(h.ctx, h.peer, "fixture")).rejects.toThrow(
			"direct model provider",
		);
		expect(h.cline.send).not.toHaveBeenCalled();
	});
	it("refuses cloud forks before constructing a new session", async () => {
		const h = harness();
		await forkPeerSession(h.ctx, h.peer, vi.fn());
		expect(h.cline.start).not.toHaveBeenCalled();
		expect(h.ctx.send).toHaveBeenCalledWith(
			h.peer,
			expect.objectContaining({
				type: "fork_error",
				text: expect.stringContaining("direct model provider"),
			}),
		);
	});
	it("refuses cloud checkpoint restore before runtime or workspace restoration", async () => {
		const h = harness();
		await expect(restorePeerSession(h.ctx, h.peer, 1, vi.fn())).rejects.toThrow(
			"direct model provider",
		);
		expect(h.cline.restore).not.toHaveBeenCalled();
	});
	it("retains direct-session creation and sending", async () => {
		const h = harness("openai-codex");
		await createSession(h.ctx, h.peer, "fixture", {
			provider: "openai-codex",
			model: "direct",
		});
		expect(h.cline.start).toHaveBeenCalled();
		await sendMessage(h.ctx, h.peer, "next");
		expect(h.cline.get).toHaveBeenCalledWith("new");
		expect(h.cline.send).toHaveBeenCalledTimes(2);
	});
});

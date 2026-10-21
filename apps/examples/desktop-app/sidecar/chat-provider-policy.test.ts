// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const access = vi.hoisted(() => ({ settings: vi.fn(), token: vi.fn() }));
vi.mock("@cline/core", async () => ({
	...(await vi.importActual<typeof import("@cline/core")>("@cline/core")),
	getProviderAuthHandler: (id: string) =>
		id === "alias-cloud" ? { storageProviderId: "cline" } : undefined,
	ProviderSettingsManager: class {
		constructor() {
			access.settings();
		}
		getProviderSettings() {
			return undefined;
		}
	},
	RuntimeOAuthTokenManager: class {
		constructor() {
			access.token();
		}
	},
}));
import {
	buildSessionConnectionUpdate,
	handleChatSessionCommand,
} from "./chat-session";
import { createSidecarContext, getEnvironmentContext } from "./context";
import type { ChatSessionCommandRequest } from "./types";
let dir: string;
beforeEach(() => {
	vi.clearAllMocks();
	dir = mkdtempSync(join(tmpdir(), "qb-chat-policy-"));
	vi.stubEnv("CLINE_DATA_DIR", dir);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => {
			throw new Error("unexpected network");
		}),
	);
});
afterEach(() => {
	expect(fetch).not.toHaveBeenCalled();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	rmSync(dir, { recursive: true, force: true });
});
function fixture(provider = "openai", kind: "local" | "ssh" = "local") {
	const ctx = createSidecarContext(dir);
	const environmentId = kind === "ssh" ? "self-controlled" : "local";
	const manager = {
		get: vi.fn(async () => ({
			sessionId: "existing",
			provider,
			model: "test",
			status: "completed",
			cwd: dir,
		})),
		start: vi.fn(async () => ({ sessionId: "created", manifest: {} })),
		send: vi.fn(async () => ({})),
		updateSessionConnection: vi.fn(async () => {}),
		stop: vi.fn(async () => {}),
		abort: vi.fn(async () => {}),
		fork: vi.fn(async () => ({ sessionId: "forked" })),
		restore: vi.fn(async () => ({ sessionId: "restored", messages: [] })),
		readMessages: vi.fn(async () => [{ role: "user", content: "old" }]),
		pendingPrompts: {
			list: vi.fn(async () => []),
			update: vi.fn(async () => ({ prompts: [], updated: true })),
		},
	};
	const hub = { command: vi.fn(async () => ({ ok: true })) };
	ctx.runtimeBindings.set(environmentId, {
		kind,
		environmentId,
		sessionManager: manager,
		hubClient: hub,
	} as never);
	const scoped = getEnvironmentContext(ctx, environmentId);
	const live = {
		config: { provider, model: "test", environmentId, cwd: dir },
		messages: [{ role: "user", content: "old" }],
		promptsInQueue: [],
		prompt: "unchanged",
		busy: false,
		status: "completed",
		startedAt: 1,
	};
	scoped.liveSessions.set("existing", live as never);
	return { ctx: scoped, manager, hub, live, environmentId };
}
describe("desktop chat direct-provider policy", () => {
	it.each([
		"steer_prompt",
		"update_pending_prompt",
	] as const)("refuses excluded %s before queued execution", async (action) => {
		const { ctx, manager, environmentId } = fixture("cline", "ssh");
		await expect(
			handleChatSessionCommand(ctx, {
				action,
				sessionId: "existing",
				promptId: "queued",
				prompt: "new",
				config: { environmentId },
			}),
		).rejects.toThrow(/unavailable in cline-qb/);
		expect(manager.pendingPrompts.update).not.toHaveBeenCalled();
	});
	it("does not refresh an excluded provider after transport loss", async () => {
		const { ctx, manager, live } = fixture();
		manager.send.mockImplementationOnce(async () => {
			live.config.provider = "cline";
			throw Object.assign(new Error("Hub connection closed"), {
				name: "HubTransportError",
			});
		});
		const result = await handleChatSessionCommand(ctx, {
			action: "send",
			sessionId: "existing",
			prompt: "new",
		});
		expect(result).toMatchObject({ result: { finishReason: "error" } });
		expect(manager.updateSessionConnection).not.toHaveBeenCalled();
		expect(manager.start).not.toHaveBeenCalled();
	});
	it.each([
		"cline",
		" CLINE-PASS ",
		"alias-cloud",
	])("rejects %s in every connection-update identity field", (provider) => {
		for (const config of [
			{ provider },
			{ providerId: provider },
			{ provider: "openai", providerConfig: { providerId: provider } },
			{
				provider: "openai",
				providerConfig: { providerId: "openai", routingProviderId: provider },
			},
		])
			expect(() => buildSessionConnectionUpdate(config)).toThrow(
				/unavailable in cline-qb/,
			);
	});
	it("preserves ordinary partial direct-provider updates", () => {
		expect(buildSessionConnectionUpdate({ thinking: false })).toMatchObject({
			thinking: false,
		});
		expect(
			buildSessionConnectionUpdate({ provider: "openai", model: "test" }),
		).toMatchObject({ providerId: "openai", modelId: "test" });
	});
	it.each([
		"local",
		"ssh",
	] as const)("refuses excluded start before credentials or runtime creation on %s", async (kind) => {
		for (const provider of ["cline", "cline-pass", "alias-cloud"]) {
			const { ctx, manager, environmentId } = fixture("openai", kind);
			await expect(
				handleChatSessionCommand(ctx, {
					action: "start",
					config: { provider, model: "test", cwd: dir, environmentId },
				}),
			).rejects.toThrow(/unavailable in cline-qb/);
			expect(manager.start).not.toHaveBeenCalled();
		}
		expect(access.settings).not.toHaveBeenCalled();
		expect(access.token).not.toHaveBeenCalled();
	});
	it("refuses a start with no selected provider before runtime creation", async () => {
		const { ctx, manager, environmentId } = fixture("openai", "ssh");
		await expect(
			handleChatSessionCommand(ctx, {
				action: "start",
				config: { model: "test", environmentId },
			}),
		).rejects.toThrow(/No model provider configured/);
		expect(manager.start).not.toHaveBeenCalled();
	});
	it.each([
		"send",
		"fork",
		"restore_checkpoint",
	] as const)("refuses excluded %s before state changes or execution", async (action) => {
		const { ctx, manager, live, environmentId } = fixture("cline", "ssh");
		const before = structuredClone(live);
		await expect(
			handleChatSessionCommand(ctx, {
				action,
				sessionId: "existing",
				prompt: "new",
				checkpointRunCount: 1,
				config: { provider: "cline", model: "test", cwd: dir, environmentId },
			} as ChatSessionCommandRequest),
		).rejects.toThrow(/unavailable in cline-qb/);
		for (const fn of [
			manager.send,
			manager.start,
			manager.fork,
			manager.restore,
			manager.updateSessionConnection,
		])
			expect(fn).not.toHaveBeenCalled();
		expect(live).toEqual(before);
		expect(access.settings).not.toHaveBeenCalled();
		expect(access.token).not.toHaveBeenCalled();
	});
	it("refuses attaching a persisted Cline session before hub attach or projection", async () => {
		const { ctx, hub, live, environmentId } = fixture("cline", "ssh");
		const before = structuredClone(live);
		await expect(
			handleChatSessionCommand(ctx, {
				action: "attach",
				sessionId: "existing",
				config: { environmentId },
			}),
		).rejects.toThrow(/unavailable in cline-qb/);
		expect(hub.command).not.toHaveBeenCalled();
		expect(live).toEqual(before);
	});
	it("refuses a cold send whose authoritative persisted provider is Cline", async () => {
		const { ctx, manager, environmentId } = fixture("cline", "ssh");
		ctx.liveSessions.clear();
		await expect(
			handleChatSessionCommand(ctx, {
				action: "send",
				sessionId: "existing",
				prompt: "new",
				config: { environmentId },
			}),
		).rejects.toThrow(/unavailable in cline-qb/);
		expect(manager.send).not.toHaveBeenCalled();
		expect(manager.updateSessionConnection).not.toHaveBeenCalled();
	});
	it("still permits aborting an old local session without credential access", async () => {
		const { ctx, manager, environmentId } = fixture("cline");
		await expect(
			handleChatSessionCommand(ctx, {
				action: "abort",
				sessionId: "existing",
				config: { environmentId },
			}),
		).resolves.toMatchObject({ ok: true });
		expect(manager.abort).toHaveBeenCalledOnce();
		expect(access.settings).not.toHaveBeenCalled();
	});
});

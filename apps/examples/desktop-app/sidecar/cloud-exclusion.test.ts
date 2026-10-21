// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudSessionManager, getCloudSessionManager } from "./cloud-sessions";
import { createSidecarContext, getEnvironmentContext } from "./context";
import { handleChatSessionCommand } from "./chat-session";
import { handleCommand } from "./commands";
import type { ChatSessionCommandRequest } from "./types";
let dataDir: string;
beforeEach(() => {
	dataDir = mkdtempSync(join(tmpdir(), "qb-cloud-boundary-"));
	vi.stubEnv("CLINE_DATA_DIR", dataDir);
	vi.stubEnv("CLINE_CODE_CLOUD_AGENTS", "1");
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => {
			throw new Error("unexpected network");
		}),
	);
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	rmSync(dataDir, { recursive: true, force: true });
});
function fixture() {
	const ctx = createSidecarContext(dataDir);
	const manager = new CloudSessionManager(ctx, {
		api: {} as never,
		apiBaseUrl: "https://blocked.invalid",
		getAuthToken: async () => "test-token",
	});
	const methods = [
		"create",
		"attach",
		"send",
		"abort",
		"pendingPrompts",
		"updatePendingPrompt",
		"removePendingPrompt",
		"listModels",
		"listRepositories",
		"listBranches",
		"readMessages",
		"listForDiscovery",
		"getCrossScopeDiscoveryRecord",
		"getCachedDiscoveryRecord",
		"updateTitle",
		"delete",
	];
	const calls = methods.map((name) => {
		const fn = vi.fn(async () => []);
		Object.defineProperty(manager, name, { value: fn });
		return fn;
	});
	ctx.cloudSessionManager = manager;
	const live = {
		config: { executionTarget: "cloud", autoApproveTools: false },
		prompt: "old",
		messages: [],
		promptsInQueue: [],
		busy: false,
		status: "completed",
		startedAt: 1,
	};
	ctx.liveSessions.set("legacy-cloud", live as never);
	return { ctx, manager, calls, live };
}
describe("desktop cloud execution boundary", () => {
	it.each([
		"local",
		"ssh-remote",
	])("refuses cold and seeded factories in %s without replacing state", (environment) => {
		const { ctx, manager } = fixture();
		const scoped = getEnvironmentContext(ctx, environment);
		expect(() => getCloudSessionManager(scoped)).toThrow(
			/unavailable in cline-qb/,
		);
		expect(ctx.cloudSessionManager).toBe(manager);
		ctx.cloudSessionManager = null;
		expect(() => getCloudSessionManager(scoped)).toThrow(
			/unavailable in cline-qb/,
		);
		expect(ctx.cloudSessionManager).toBeNull();
		expect(fetch).not.toHaveBeenCalled();
	});
	const actions = [
		"start",
		"attach",
		"send",
		"stop",
		"abort",
		"fork",
		"reset",
		"restore_checkpoint",
		"pending_prompts",
		"steer_prompt",
		"update_pending_prompt",
		"remove_pending_prompt",
	] as const;
	it.each(
		actions,
	)("refuses %s on explicit, cold-id and legacy targets before state mutation or transport", async (action) => {
		for (const target of ["explicit", "cold-id", "legacy"] as const) {
			const { ctx, calls, live } = fixture();
			const sessionId = target === "legacy" ? "legacy-cloud" : "ses-existing";
			const request = {
				action,
				sessionId,
				promptId: "q-1",
				prompt: "test",
				config: {
					...(target === "explicit" ? { executionTarget: "cloud" } : {}),
					autoApproveTools: true,
					sessionId,
				},
			} as ChatSessionCommandRequest;
			await expect(
				handleChatSessionCommand(
					getEnvironmentContext(ctx, "ssh-remote"),
					request,
				),
			).rejects.toThrow(/unavailable in cline-qb/);
			for (const fn of calls) expect(fn).not.toHaveBeenCalled();
			expect(live.config.autoApproveTools).toBe(false);
			expect(ctx.liveSessions.get("legacy-cloud")).toBe(live);
			expect(fetch).not.toHaveBeenCalled();
		}
	});
	it.each([
		"sessionId",
		"session_id",
	])("refuses a cloud start identified only by nested %s", async (key) => {
		const { ctx, calls } = fixture();
		await expect(
			handleChatSessionCommand(ctx, {
				action: "start",
				config: { [key]: "ses-existing", provider: "openai", model: "test" },
			}),
		).rejects.toThrow(/unavailable in cline-qb/);
		for (const fn of calls) expect(fn).not.toHaveBeenCalled();
	});
	it.each([
		"list_cloud_models",
		"list_cloud_repositories",
		"list_cloud_branches",
		"read_session_messages",
		"get_discovered_session",
		"update_chat_session_title",
		"delete_chat_session",
		"delete_cli_session",
	])("refuses %s without account or transport access", async (command) => {
		const { ctx, calls } = fixture();
		await expect(
			handleCommand(ctx, command, {
				sessionId: "ses-existing",
				title: "new",
				repositoryId: 1,
			}),
		).rejects.toThrow(/unavailable in cline-qb/);
		for (const fn of calls) expect(fn).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	});
});

describe("permitted sessions without cloud manager construction", () => {
	it.each([
		["local", "permitted-session"],
		["ssh", "permitted-session"],
		["ssh", "ses-collision"],
		["ssh", "legacy-collision"],
	] as const)("preserves %s session %s without an account or cross-environment confusion", async (kind, id) => {
		const ctx = createSidecarContext(dataDir);
		const manager = {
			pendingPrompts: { list: vi.fn(async () => []) },
			get: vi.fn(async () => ({
				sessionId: id,
				title: "Before",
				status: "completed",
				messages: [],
			})),
			readMessages: vi.fn(async () => [
				{ role: "user", content: "permitted message" },
			]),
			update: vi.fn(async () => ({ updated: true })),
			delete: vi.fn(async () => true),
		};
		const environmentId = kind === "local" ? "local" : "self-controlled";
		ctx.runtimeBindings.set(environmentId, {
			kind,
			environmentId,
			sessionManager: manager,
		} as never);
		ctx.liveSessions.set(id, {
			config: {},
			messages: [{ role: "user", content: "permitted message" }],
			promptsInQueue: [],
			busy: false,
			status: "completed",
			startedAt: 1,
		} as never);
		if (kind === "ssh" && id !== "permitted-session")
			ctx.liveSessions.get(id)!.config.executionTarget = "cloud";
		const args = { environmentId, sessionId: id };
		await expect(
			handleChatSessionCommand(ctx, {
				action: "pending_prompts",
				sessionId: id,
				config: { environmentId },
			}),
		).resolves.toMatchObject({ sessionId: id, promptsInQueue: [] });
		await expect(
			handleCommand(ctx, "read_session_messages", args),
		).resolves.toHaveLength(1);
		await expect(
			handleCommand(ctx, "get_discovered_session", args),
		).resolves.toMatchObject({ sessionId: id });
		await expect(
			handleCommand(ctx, "update_chat_session_title", {
				...args,
				title: "After",
			}),
		).resolves.toBe(true);
		expect(manager.update).toHaveBeenCalledWith(id, { title: "After" });
		await expect(handleCommand(ctx, "delete_chat_session", args)).resolves.toBe(
			true,
		);
		expect(manager.delete).toHaveBeenCalledWith(id);
		expect(ctx.cloudSessionManager).toBeNull();
		expect(fetch).not.toHaveBeenCalled();
	});
});

it.each([
	"environmentId",
	"environment_id",
])("cannot redirect an explicit cloud target through SSH using %s", async (key) => {
	const { ctx, calls } = fixture();
	ctx.runtimeBindings.set("self-controlled", {
		kind: "ssh",
		environmentId: "self-controlled",
	} as never);
	await expect(
		handleChatSessionCommand(ctx, {
			action: "send",
			sessionId: "ses-existing",
			prompt: "test",
			config: { [key]: "self-controlled", executionTarget: "cloud" },
		}),
	).rejects.toThrow(/unavailable in cline-qb/);
	for (const fn of calls) expect(fn).not.toHaveBeenCalled();
});

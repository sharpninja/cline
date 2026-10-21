// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, it, vi } from "vitest";
import type { RuntimeHost } from "../../runtime/host/runtime-host";
const { defaultHost, defaultStore } = vi.hoisted(() => ({
	defaultHost: vi.fn(function () {
		throw new Error("unguarded default host constructed");
	}),
	defaultStore: vi.fn(function () {
		throw new Error("default store constructed");
	}),
}));
vi.mock("../../runtime/host/local-runtime-host", () => ({
	LocalRuntimeHost: defaultHost,
}));
vi.mock("../../services/storage/sqlite-session-store", () => ({
	SqliteSessionStore: defaultStore,
}));
import { createLocalHubScheduleRuntimeHandlers } from "./runtime-handlers";
afterEach(() => vi.clearAllMocks());
function owned() {
	return {
		startSession: vi.fn<RuntimeHost["startSession"]>(async () => ({
			sessionId: "owned-session",
			manifestPath: "manifest",
			messagesPath: "messages",
			manifest: {} as Awaited<
				ReturnType<RuntimeHost["startSession"]>
			>["manifest"],
		})),
		runTurn: vi.fn<RuntimeHost["runTurn"]>(async () => ({
			text: "done",
			messages: [],
			model: { id: "direct", provider: "openai-compatible" },
			startedAt: new Date(0),
			endedAt: new Date(1),
			durationMs: 1,
			usage: { inputTokens: 1, outputTokens: 2, totalCost: 0 },
			iterations: 1,
			finishReason: "completed",
			toolCalls: [],
		})),
		abort: vi.fn<RuntimeHost["abort"]>(async () => {}),
		stopSession: vi.fn<RuntimeHost["stopSession"]>(async () => {}),
	};
}
it("AC013 all schedule operations retain the supplied governed session host", async () => {
	const sessionHost = owned();
	const handlers = createLocalHubScheduleRuntimeHandlers({
		sessionHost,
	});
	const started = await handlers.startSession({
		workspaceRoot: "/workspace",
		cwd: "/workspace",
		provider: "openai",
		model: "direct",
		source: "hub-schedule",
		enableTools: false,
		configExtensions: [],
	} as never);
	expect(started.sessionId).toBe("owned-session");
	expect(sessionHost.startSession).toHaveBeenCalledOnce();
	expect(sessionHost.startSession).toHaveBeenCalledWith(
		expect.objectContaining({
			config: expect.objectContaining({
				providerId: "openai-compatible",
				enableTools: false,
				workspaceRoot: "/workspace",
			}),
		}),
	);
	expect(
		(
			await handlers.sendSession("owned-session", {
				prompt: "continue",
			} as never)
		).result.text,
	).toBe("done");
	expect(sessionHost.runTurn).toHaveBeenCalledWith(
		expect.objectContaining({ sessionId: "owned-session", prompt: "continue" }),
	);
	await handlers.abortSession("owned-session");
	await handlers.stopSession("owned-session");
	expect(sessionHost.abort).toHaveBeenCalledWith(
		"owned-session",
		expect.any(Error),
	);
	expect(sessionHost.stopSession).toHaveBeenCalledWith("owned-session");
	expect(defaultHost).not.toHaveBeenCalled();
	expect(defaultStore).not.toHaveBeenCalled();
});
it("AC002 supplied host refusal propagates without a fallback runtime", async () => {
	const sessionHost = owned();
	sessionHost.startSession.mockRejectedValue(
		new Error("governance prerequisites missing"),
	);
	const handlers = createLocalHubScheduleRuntimeHandlers({
		sessionHost,
	});
	await expect(
		handlers.startSession({
			workspaceRoot: "/workspace",
			provider: "openai",
			model: "direct",
		} as never),
	).rejects.toThrow("governance prerequisites missing");
	expect(defaultHost).not.toHaveBeenCalled();
	expect(defaultStore).not.toHaveBeenCalled();
});
it("AC013 concurrent schedule requests keep one host with distinct session addressing", async () => {
	const sessionHost = owned();
	const handlers = createLocalHubScheduleRuntimeHandlers({
		sessionHost,
	});
	await Promise.all([
		handlers.sendSession("first", { prompt: "a" } as never),
		handlers.sendSession("second", { prompt: "b" } as never),
	]);
	expect(sessionHost.runTurn.mock.calls.map(([input]) => input)).toEqual([
		expect.objectContaining({ sessionId: "first", prompt: "a" }),
		expect.objectContaining({ sessionId: "second", prompt: "b" }),
	]);
	expect(defaultHost).not.toHaveBeenCalled();
});

it("generic SDK callers retain the default runtime construction path", () => {
	expect(() => createLocalHubScheduleRuntimeHandlers()).toThrow(
		"default store constructed",
	);
	expect(defaultStore).toHaveBeenCalledOnce();
});

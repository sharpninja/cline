import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	clearLiveModelsCatalogCache,
	resetClineRecommendedModelsCacheForTests,
} from "@cline/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudSessionManager } from "./cloud-sessions";
import { handleCommand } from "./commands";
import { createSidecarContext } from "./context";
import {
	resolveDesktopSettingsPath,
	setCloudSessionsEnabled,
} from "./desktop-settings";
import {
	getDesktopFeatureFlagsService,
	resetDesktopFeatureFlagsForTesting,
} from "./feature-flags";
import type { SidecarContext } from "./types";

function createContext(): {
	ctx: SidecarContext;
	events: Array<{ name: string; payload: Record<string, unknown> }>;
} {
	const events: Array<{ name: string; payload: Record<string, unknown> }> = [];
	const ctx = createSidecarContext("/local/workspace");
	ctx.wsClients.add({
		send: (message) => events.push(JSON.parse(message).event),
	});
	return { ctx, events };
}

let dataDir: string;

beforeEach(() => {
	dataDir = mkdtempSync(join(tmpdir(), "cline-commands-settings-"));
	process.env.CLINE_DATA_DIR = dataDir;
	resetDesktopFeatureFlagsForTesting();
});

afterEach(() => {
	clearLiveModelsCatalogCache();
	resetClineRecommendedModelsCacheForTests();
	vi.unstubAllGlobals();
	delete process.env.CLINE_CODE_CLOUD_AGENTS;
	delete process.env.CLINE_DATA_DIR;
	resetDesktopFeatureFlagsForTesting();
	rmSync(dataDir, { recursive: true, force: true });
});

describe("desktop settings commands", () => {
	it("lists only current gateway transcription models for voice input", async () => {
		const { ctx } = createContext();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({
					data: [
						{
							id: "stt",
							modalities: { input: ["audio"], output: ["text"] },
							supported_specifications: ["v4"],
						},
						{
							id: "transcribe-chat",
							type: "language",
							modalities: { input: ["text", "audio"], output: ["text"] },
							supported_specifications: ["v4"],
						},
					],
				}),
			),
		);
		const result = (await handleCommand(ctx, "list_transcription_models", {
			provider: "vercel-ai-gateway",
		})) as { models: Array<{ id: string }> };
		expect(result.models.map((model) => model.id)).toEqual(["stt"]);
	});

	it.each([
		"list_chat_sessions",
		"list_discovered_sessions",
		"search_sessions",
	])("keeps cloud rows hidden from %s despite saved settings, cache and overrides", async (command) => {
		const { ctx } = createContext();
		for (const target of ["local", "cloud"] as const) {
			ctx.liveSessions.set(target, {
				config: { executionTarget: target, provider: "cline", model: "test" },
				prompt: "match",
				messages: [],
				promptsInQueue: [],
				busy: false,
				status: "completed",
				startedAt: Date.now(),
			});
		}
		const cloudRows = [
			{ sessionId: "cloud", origin: "cloud", prompt: "match" },
		];
		const retained = new CloudSessionManager(ctx, {
			api: {} as never,
			apiBaseUrl: "https://blocked.invalid",
			getAuthToken: async () => "test-token",
		});
		ctx.cloudSessionManager = retained;
		const discovery = vi
			.spyOn(retained, "listForDiscovery")
			.mockResolvedValue(cloudRows);
		const flags = getDesktopFeatureFlagsService();
		flags.hydrateCache({
			userId: null,
			updateTime: Date.now(),
			flagsPayload: { featureFlags: { "code-cloud-agents": true } },
		});
		const rows = async () =>
			(
				(await handleCommand(ctx, command, { query: "match" })) as Array<{
					sessionId: string;
				}>
			)
				.map((row) => row.sessionId)
				.sort();

		expect(await rows()).toEqual(["local"]);
		expect(discovery).not.toHaveBeenCalled();
		const path = resolveDesktopSettingsPath();
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify({ cloudSessionsEnabled: true }));
		process.env.CLINE_CODE_CLOUD_AGENTS = "1";
		expect(() => setCloudSessionsEnabled(true)).toThrow(
			/Cline account services are unavailable/,
		);
		expect(await rows()).toEqual(["local"]);
		expect(discovery).not.toHaveBeenCalled();
		expect(ctx.liveSessions.has("cloud")).toBe(true);
	});

	it.each([
		"list_provider_models",
		"list_transcription_models",
		"list_cline_recommended_models",
	])("rejects hosted catalog command %s before fetch", async (command) => {
		const { ctx } = createContext();
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		for (const provider of ["cline", "cline-pass", " CLINE "]) {
			process.env.CLINE_CODE_CLOUD_AGENTS = "1";
			await expect(
				handleCommand(ctx, command, { provider, includeCloudModels: true }),
			).rejects.toThrow(/Cline account services are unavailable/);
		}
		expect(fetchMock).not.toHaveBeenCalled();
	});
	it("lists direct providers without hosted providers or an account lookup", async () => {
		const { ctx } = createContext();
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const result = (await handleCommand(ctx, "list_provider_catalog", {})) as {
			providers: Array<{ id: string }>;
		};
		expect(result.providers.some((p) => p.id === "openai-codex")).toBe(true);
		expect(
			result.providers.some((p) => p.id === "cline" || p.id === "cline-pass"),
		).toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
	});
	it("rejects cloud enablement without broadcasting a successful settings change", async () => {
		const { ctx, events } = createContext();
		await expect(
			handleCommand(ctx, "set_cloud_sessions_enabled", {
				cloud_sessions_enabled: true,
			}),
		).rejects.toThrow(/Cline account services are unavailable/);
		expect(events).toEqual([]);
	});
	it("rejects a non-boolean cloud sessions toggle value", async () => {
		const { ctx, events } = createContext();

		await expect(
			handleCommand(ctx, "set_cloud_sessions_enabled", {
				cloud_sessions_enabled: "yes",
			}),
		).rejects.toThrow("cloud_sessions_enabled must be a boolean");
		expect(events).toEqual([]);
	});

	it("reports cloud disabled and refreshes the client without enabling execution", async () => {
		const enabled = false;
		const { ctx, events } = createContext();

		await expect(
			handleCommand(ctx, "set_cloud_sessions_enabled", {
				cloud_sessions_enabled: enabled,
			}),
		).resolves.toEqual({ cloudSessionsEnabled: enabled });
		expect(events).toEqual([
			{ name: "cloud_sessions_changed", payload: { environmentId: "local" } },
			{
				name: "feature_flags_changed",
				payload: {
					cloudAgents: false,
					cloudAgentsAvailable: false,
					environmentId: "local",
				},
			},
		]);
		await expect(
			handleCommand(ctx, "get_feature_flags", {}),
		).resolves.toMatchObject({ cloudAgents: false });
		await expect(
			handleCommand(ctx, "get_desktop_settings", {}),
		).resolves.toEqual({ cloudSessionsEnabled: enabled });
	});
});

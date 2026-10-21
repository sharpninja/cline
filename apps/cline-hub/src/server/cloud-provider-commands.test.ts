// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HubContext } from "./state";
import type { BrowserPeer } from "./types";

const fake = vi.hoisted(() => ({
	settings: {
		getLastUsedProviderSettings: vi.fn(),
		getProviderConfig: vi.fn(),
		getProviderSettings: vi.fn(),
		read: vi.fn(),
	},
	models: vi.fn(),
	save: vi.fn(),
	oauth: vi.fn(),
	add: vi.fn(),
	ensure: vi.fn(),
	catalog: vi.fn(),
	info: vi.fn(),
	open: vi.fn(),
	account: vi.fn(),
	settingsWrite: vi.fn(),
	schedule: vi.fn(),
	runtimeFactory: vi.fn(),
	runtimeStart: vi.fn(),
	runtimeSend: vi.fn(),
}));
vi.mock("./deps", () => ({
	providerSettingsManager: fake.settings,
	workspaceRoot: "/fixture",
	cliIndexPath: "/fixture/cli",
	options: {},
}));
vi.mock("./utils", async (importOriginal) => ({
	...(await importOriginal<typeof import("./utils")>()),
	openExternalUrl: fake.open,
}));
vi.mock("./state-payloads", () => ({
	broadcastHubState: vi.fn(),
	hubStatePayload: vi.fn(),
}));
vi.mock("@cline/core", async (importOriginal) => ({
	...(await importOriginal<typeof import("@cline/core")>()),
	ensureCustomProvidersLoaded: fake.ensure,
	getLocalProviderModels: fake.models,
	saveLocalProviderSettings: fake.save,
	loginAndSaveLocalProviderOAuthCredentials: fake.oauth,
	addLocalProvider: fake.add,
	listLocalProviders: fake.catalog,
	Llms: {
		getProviderIds: () => ["cline", "cline-pass", "openai-codex"],
		getProvider: fake.info,
	},
	ClineAccountService: class {
		constructor() {
			fake.account();
		}
	},
	setAutoUpdateEnabledGlobally: fake.settingsWrite,
	setTelemetryOptOutGlobally: fake.settingsWrite,
	createLocalHubScheduleRuntimeHandlers: fake.runtimeFactory,
	HubScheduleService: class {},
	HubScheduleCommandService: class {
		handleCommand(...args: unknown[]) {
			return fake.schedule(...args);
		}
	},
}));

import { handleDesktopCommand } from "./desktop-commands";
import {
	loadModels,
	loadProviders,
	resolveBrowserDefaults,
	runProviderOAuthLogin,
	saveProviderSettings,
	sendProviderCatalog,
} from "./providers";
import {
	createDirectScheduleRuntimeHandlers,
	handleRoutineScheduleCommand,
} from "./schedules";

const ctx = () =>
	({
		send: vi.fn(),
		sessions: new Map(),
		peers: new Set(),
	}) as unknown as HubContext;
const peer = {} as BrowserPeer;
beforeEach(() => {
	vi.clearAllMocks();
	vi.unstubAllEnvs();
	fake.runtimeStart.mockResolvedValue({ sessionId: "admitted" });
	fake.runtimeSend.mockResolvedValue({ result: { text: "fixture" } });
	fake.runtimeFactory.mockReturnValue({
		startSession: fake.runtimeStart,
		sendSession: fake.runtimeSend,
		abortSession: vi.fn(async () => ({ applied: true })),
		stopSession: vi.fn(async () => ({ applied: true })),
	});
	fake.settings.getLastUsedProviderSettings.mockReturnValue(undefined);
	fake.settings.getProviderSettings.mockReturnValue({ apiKey: "fixture-only" });
	fake.settings.getProviderConfig.mockReturnValue({});
	fake.settings.read.mockReturnValue({
		providers: {
			cline: { settings: {} },
			"cline-pass": { settings: {} },
			"openai-codex": { settings: {} },
		},
	});
	fake.models.mockResolvedValue({ models: [] });
	fake.oauth.mockResolvedValue({
		provider: "openai-codex",
		apiKey: "fixture-only",
	});
	fake.save.mockResolvedValue({ providerId: "openai-codex", enabled: true });
	fake.info.mockImplementation(async (id: string) => ({ name: id }));
	fake.catalog.mockImplementation(async (_manager, options) => ({
		providers: ["cline", "cline-pass", "openai-codex"]
			.filter((id) => !options.includeProvider || options.includeProvider(id))
			.map((id) => ({ id })),
		settingsPath: "fixture",
	}));
	fake.schedule.mockImplementation(async (frame) => ({
		ok: true,
		payload:
			frame.command === "schedule.get"
				? {
						schedule: {
							modelSelection: { providerId: "cline", modelId: "legacy" },
						},
					}
				: { schedule: {} },
	}));
});
describe("TEST-QB-016/017: hub provider and account boundary", () => {
	it.each([
		"cline",
		"cline-pass",
		" CLINE ",
	])("refuses cloud %s through both command APIs before side effects", async (provider) => {
		const c = ctx();
		for (const [command, args] of [
			["list_provider_models", { provider }],
			["save_provider_settings", { provider }],
			["add_provider", { provider_id: provider }],
			["run_provider_oauth_login", { provider }],
		] as const) {
			await expect(handleDesktopCommand(c, command, args)).rejects.toThrow(
				"direct model provider",
			);
		}
		await expect(loadModels(c, peer, provider)).rejects.toThrow(
			"direct model provider",
		);
		await expect(runProviderOAuthLogin(c, peer, provider)).rejects.toThrow(
			"direct model provider",
		);
		await expect(
			saveProviderSettings(c, peer, {
				type: "saveProviderSettings",
				providerId: provider,
				enabled: true,
			}),
		).rejects.toThrow("direct model provider");
		for (const fn of [
			fake.settings.getProviderConfig,
			fake.settings.getProviderSettings,
			fake.models,
			fake.save,
			fake.oauth,
			fake.add,
			fake.open,
		])
			expect(fn).not.toHaveBeenCalled();
	});
	it("refuses account actions before credential reads", async () => {
		await expect(
			handleDesktopCommand(ctx(), "cline_account", { action: "get_account" }),
		).rejects.toThrow("direct model provider");
		expect(fake.settings.getProviderSettings).not.toHaveBeenCalled();
		expect(fake.account).not.toHaveBeenCalled();
	});
	it("filters both provider catalogs before resolving cloud metadata", async () => {
		const c = ctx();
		const result = (await handleDesktopCommand(c, "list_provider_catalog")) as {
			providers: { id: string }[];
		};
		expect(result.providers.map((p) => p.id)).toEqual(["openai-codex"]);
		await sendProviderCatalog(c, peer);
		expect(c.send).toHaveBeenCalledWith(
			peer,
			expect.objectContaining({ providers: [{ id: "openai-codex" }] }),
		);
		await loadProviders(c, peer);
		expect(fake.info.mock.calls.map((c) => c[0])).toEqual(["openai-codex"]);
		expect(fake.models).not.toHaveBeenCalled();
	});
	it("retains explicitly configured direct provider operations", async () => {
		const c = ctx();
		await loadModels(c, peer, "openai-codex");
		expect(fake.models).toHaveBeenCalledWith("openai-codex", {});
		await handleDesktopCommand(c, "save_provider_settings", {
			provider: "openai-codex",
			api_key: "fixture-only",
		});
		expect(fake.save).toHaveBeenCalled();
		await handleDesktopCommand(c, "run_provider_oauth_login", {
			provider: "openai-codex",
		});
		expect(fake.oauth).toHaveBeenCalled();
	});
	it("rejects stored cloud defaults instead of substituting another provider", () => {
		fake.settings.getLastUsedProviderSettings.mockReturnValue({
			provider: "cline",
			model: "legacy",
		});
		expect(() => resolveBrowserDefaults(ctx())).toThrow(
			"direct model provider",
		);
	});
	it("ignores upstream provider environment and reads the private environment", () => {
		vi.stubEnv("CLINE_PROVIDER", "cline");
		vi.stubEnv("CLINE_MODEL", "legacy");
		vi.stubEnv("CLINE_QB_PROVIDER", "openai-codex");
		vi.stubEnv("CLINE_QB_MODEL", "direct-model");
		expect(resolveBrowserDefaults(ctx())).toMatchObject({
			provider: "openai-codex",
			model: "direct-model",
		});
	});
	it.each([
		"set_auto_update_enabled",
		"set_telemetry_opt_out",
	])("refuses legacy control %s without writing settings", async (command) => {
		await expect(
			handleDesktopCommand(ctx(), command, {
				auto_update_enabled: true,
				telemetry_opt_out: false,
			}),
		).rejects.toThrow("unavailable in cline-qb");
		expect(fake.settingsWrite).not.toHaveBeenCalled();
	});
});
describe("TEST-QB-016/017: hub schedule provider boundary", () => {
	const args = {
		name: "fixture",
		prompt: "fixture",
		workspace_root: "/fixture",
		cron_pattern: "0 * * * *",
		schedule_id: "fixture",
		model: "direct-model",
	};
	it.each([
		undefined,
		"cline",
		"cline-pass",
	])("refuses creation/update with provider %s", async (provider) => {
		for (const command of [
			"create_routine_schedule",
			"update_routine_schedule",
		])
			await expect(
				handleRoutineScheduleCommand(command, { ...args, provider }),
			).rejects.toThrow("direct model provider");
		expect(fake.schedule).not.toHaveBeenCalled();
	});
	it("requires an explicit model without the Cline default", async () => {
		await expect(
			handleRoutineScheduleCommand("create_routine_schedule", {
				...args,
				provider: "openai-codex",
				model: undefined,
			}),
		).rejects.toThrow("model");
		expect(fake.schedule).not.toHaveBeenCalled();
	});
	it.each([
		"resume_routine_schedule",
		"trigger_routine_schedule",
	])("refuses stored cloud schedule on %s", async (command) => {
		await expect(handleRoutineScheduleCommand(command, args)).rejects.toThrow(
			"direct model provider",
		);
		expect(fake.schedule.mock.calls.map((c) => c[0].command)).toEqual([
			"schedule.get",
		]);
	});
	it("allows explicit direct schedule creation", async () => {
		await handleRoutineScheduleCommand("create_routine_schedule", {
			...args,
			provider: "openai-codex",
		});
		expect(fake.schedule).toHaveBeenCalledWith(
			expect.objectContaining({
				command: "schedule.create",
				payload: expect.objectContaining({
					modelSelection: {
						providerId: "openai-codex",
						modelId: "direct-model",
					},
				}),
			}),
			expect.anything(),
		);
	});
});
describe("TEST-QB-016/017: background schedule runtime admission", () => {
	it.each([
		undefined,
		"cline",
		"cline-pass",
	])("refuses provider %s before constructing the local runtime", async (provider) => {
		const runtime = createDirectScheduleRuntimeHandlers();
		await expect(
			runtime.startSession({
				provider,
				model: "legacy",
				workspaceRoot: "/fixture",
			} as never),
		).rejects.toThrow("direct model provider");
		expect(fake.runtimeFactory).not.toHaveBeenCalled();
		expect(fake.runtimeStart).not.toHaveBeenCalled();
	});
	it("refuses a missing model before runtime construction", async () => {
		const runtime = createDirectScheduleRuntimeHandlers();
		await expect(
			runtime.startSession({
				provider: "openai-codex",
				workspaceRoot: "/fixture",
			} as never),
		).rejects.toThrow("model");
		expect(fake.runtimeFactory).not.toHaveBeenCalled();
	});
	it("refuses a replayed or foreign session id without constructing a runtime", async () => {
		const runtime = createDirectScheduleRuntimeHandlers();
		await expect(
			runtime.sendSession("foreign", { prompt: "fixture" } as never),
		).rejects.toThrow("admission");
		expect(fake.runtimeFactory).not.toHaveBeenCalled();
		expect(fake.runtimeSend).not.toHaveBeenCalled();
	});
	it("executes only an admitted direct run and removes admission on stop", async () => {
		const runtime = createDirectScheduleRuntimeHandlers();
		await runtime.startSession({
			provider: "openai-codex",
			model: "direct",
			workspaceRoot: "/fixture",
		} as never);
		await runtime.sendSession("admitted", { prompt: "fixture" } as never);
		expect(fake.runtimeStart).toHaveBeenCalledTimes(1);
		expect(fake.runtimeSend).toHaveBeenCalledTimes(1);
		await runtime.stopSession("admitted");
		await expect(
			runtime.sendSession("admitted", { prompt: "again" } as never),
		).rejects.toThrow("admission");
		expect(fake.runtimeSend).toHaveBeenCalledTimes(1);
	});
});

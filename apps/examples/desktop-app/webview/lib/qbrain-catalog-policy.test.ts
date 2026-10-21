// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from "vitest";
import { desktopClient } from "./desktop-client";
import {
	buildProviderModelCatalog,
	fetchProviderCatalog,
	invalidateProviderCatalogCache,
	loadProviderModelCatalog,
	loadProviderModels,
	loadTranscriptionModels,
	notifyVoiceInputSettingsChanged,
	publishProviderModels,
	readProviderCatalogSnapshot,
	readVoiceInputCatalog,
	selectTranscriptionModel,
	subscribeToProviderModels,
	writeProviderCatalogSnapshot,
} from "./provider-model-catalog";
import type { Provider } from "./provider-schema";

const blocked = [
	"cline",
	"cline-pass",
	"cline-cloud",
	" CLINE-PASS ",
	" CLINE-CLOUD ",
];
const voice = {
	id: "voice",
	name: "Voice",
	operation: "transcription" as const,
	operationModes: ["streaming" as const],
	inputModalities: ["audio" as const],
	outputModalities: ["text" as const],
};
function provider(id: string): Provider {
	return {
		id,
		name: id,
		enabled: true,
		apiKey: "synthetic",
		models: 2,
		color: "",
		letter: "P",
		modelList: [{ id: "chat", name: "Chat" }, voice],
	};
}
afterEach(() => {
	invalidateProviderCatalogCache();
	vi.restoreAllMocks();
});
describe("TEST-QB-016/017/018 desktop catalog boundary", () => {
	it.each(blocked)("rejects discovery for %s before IPC", async (id) => {
		const invoke = vi
			.spyOn(desktopClient, "invoke")
			.mockResolvedValue({ models: [] });
		await expect(loadProviderModels(id)).rejects.toMatchObject({
			code: "cline_cloud_disabled",
		});
		await expect(
			Promise.resolve().then(() => loadTranscriptionModels(id)),
		).rejects.toMatchObject({ code: "cline_cloud_disabled" });
		expect(invoke).not.toHaveBeenCalled();
	});
	it("rejects explicit Cloud catalog flags before any IPC", async () => {
		const invoke = vi.spyOn(desktopClient, "invoke").mockResolvedValue([]);
		await expect(
			loadProviderModelCatalog({ includeCloudModels: true }),
		).rejects.toMatchObject({ code: "cline_cloud_disabled" });
		await expect(
			loadProviderModels("anthropic", { includeCloudModels: true }),
		).rejects.toMatchObject({ code: "cline_cloud_disabled" });
		expect(invoke).not.toHaveBeenCalled();
	});
	it.each(
		blocked,
	)("filters stale %s metadata and voice selections without mutating input", async (id) => {
		const input = [provider(id), provider("anthropic")];
		const before = JSON.stringify(input);
		const selection = { providerId: id, modelId: "voice" };
		const built = buildProviderModelCatalog(input, selection);
		expect(built.providers.map((p) => p.id)).toEqual(["anthropic"]);
		expect(Object.keys(built.providerModels)).toEqual(["anthropic"]);
		expect(built.voiceInput).toBeNull();
		expect(selectTranscriptionModel(input, selection)).toBeNull();
		const invoke = vi
			.spyOn(desktopClient, "invoke")
			.mockResolvedValue({ providers: input, voiceInput: selection });
		const fetched = await fetchProviderCatalog();
		expect(fetched.providers.map((p) => p.id)).toEqual(["anthropic"]);
		expect(fetched.voiceInput).toBeUndefined();
		const catalog = await loadProviderModelCatalog({ includeVoiceInput: true });
		expect(catalog.voiceInput).toBeNull();
		expect(invoke).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(input)).toBe(before);
	});
	it("drops late excluded publications without invalidating a permitted snapshot", () => {
		const listener = vi.fn();
		const unsubscribe = subscribeToProviderModels(listener);
		try {
			writeProviderCatalogSnapshot({
				credentials: { anthropic: { apiKey: "synthetic" } },
				contextWindows: { anthropic: { chat: 100 } },
			});
			for (const id of blocked)
				publishProviderModels(id, provider(id).modelList ?? []);
			expect(listener).not.toHaveBeenCalled();
			expect(readProviderCatalogSnapshot()?.credentials.anthropic.apiKey).toBe(
				"synthetic",
			);
			publishProviderModels("anthropic", provider("anthropic").modelList ?? []);
			expect(listener).toHaveBeenCalledExactlyOnceWith("anthropic", [
				{ id: "chat", name: "Chat" },
			]);
		} finally {
			unsubscribe();
		}
	});
	it("keeps excluded credentials out of snapshots even after caller mutation", () => {
		const input = {
			credentials: Object.fromEntries(
				[...blocked, "anthropic"].map((id) => [id, { apiKey: "synthetic" }]),
			),
			contextWindows: Object.fromEntries(
				[...blocked, "anthropic"].map((id) => [id, { chat: 100 }]),
			),
		};
		writeProviderCatalogSnapshot(input);
		input.credentials.cline = { apiKey: "late" };
		const first = readProviderCatalogSnapshot();
		expect(Object.keys(first?.credentials ?? {})).toEqual(["anthropic"]);
		expect(Object.keys(first?.contextWindows ?? {})).toEqual(["anthropic"]);
		if (first) first.credentials.cline = { apiKey: "late read mutation" };
		expect(
			Object.keys(readProviderCatalogSnapshot()?.credentials ?? {}),
		).toEqual(["anthropic"]);
	});
	it("ignores excluded voice settings on a cached permitted catalog", async () => {
		vi.spyOn(desktopClient, "invoke").mockResolvedValue({ providers: [] });
		await fetchProviderCatalog();
		notifyVoiceInputSettingsChanged({
			voiceInput: { providerId: "cline-cloud", modelId: "voice" },
		});
		expect(readVoiceInputCatalog()?.voiceInput).toBeUndefined();
	});
	it("retains direct chat discovery and surfaced credential failures", async () => {
		const invoke = vi
			.spyOn(desktopClient, "invoke")
			.mockResolvedValue({ models: provider("anthropic").modelList });
		expect(await loadProviderModels("anthropic")).toEqual([
			{ id: "chat", name: "Chat" },
		]);
		expect(invoke).toHaveBeenCalledExactlyOnceWith("list_provider_models", {
			provider: "anthropic",
		});
		invoke.mockRejectedValueOnce(new Error("401 invalid direct key"));
		await expect(loadProviderModels("openrouter")).rejects.toThrow(
			"401 invalid direct key",
		);
		expect(invoke).toHaveBeenCalledTimes(2);
	});
});

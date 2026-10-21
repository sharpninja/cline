import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ProviderSettingsManager,
	listLocalProviders as sdkListLocalProviders,
} from "@cline/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listLocalProviders } from "./provider-catalog";

let directory: string;
let manager: ProviderSettingsManager;
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "qb-catalog-"));
	manager = new ProviderSettingsManager({
		filePath: join(directory, "providers.json"),
	});
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	rmSync(directory, { recursive: true, force: true });
});
describe("TEST-QB-016/017: CLI provider catalog policy", () => {
	it("excludes cloud providers before resolving credentials, while retaining direct providers", async () => {
		const original = manager.getProviderSettings.bind(manager);
		const settings = vi
			.spyOn(manager, "getProviderSettings")
			.mockImplementation((id) => {
				if (id === "cline" || id === "cline-pass")
					throw new Error("cloud credential access");
				return original(id);
			});
		const result = await listLocalProviders(manager);
		const ids = result.providers.map((p) => p.id);
		expect(ids).toContain("anthropic");
		expect(ids).toContain("openai-codex");
		expect(ids).not.toContain("cline");
		expect(ids).not.toContain("cline-pass");
		expect(settings).not.toHaveBeenCalledWith("cline");
		expect(settings).not.toHaveBeenCalledWith("cline-pass");
	});
	it("legacy credentials cannot enable cloud catalog entries or trigger traffic", async () => {
		manager.saveProviderSettings({
			provider: "cline",
			apiKey: "fixture-legacy",
		});
		manager.saveProviderSettings({
			provider: "anthropic",
			apiKey: "fixture-direct",
		});
		const fetchMock = vi.fn(() => {
			throw new Error("unexpected network");
		});
		vi.stubGlobal("fetch", fetchMock);
		const result = await listLocalProviders(manager);
		expect(
			result.providers.some((p) => p.id === "cline" || p.id === "cline-pass"),
		).toBe(false);
		expect(result.providers.find((p) => p.id === "anthropic")?.configured).toBe(
			true,
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});
	it("unrestricted shared SDK catalog behavior remains available", async () => {
		const result = await sdkListLocalProviders(manager, {
			isClinePassEnabled: true,
		});
		expect(result.providers.map((p) => p.id)).toEqual(
			expect.arrayContaining(["cline", "cline-pass", "anthropic"]),
		);
	});
});

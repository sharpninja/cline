// SPDX-License-Identifier: Apache-2.0
import type { ProviderSettingsManager } from "@cline/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authenticateAcpProvider } from "../acp/auth";
import {
	ensureOAuthProviderApiKey,
	runAuthCommand,
	runAuthProviderCommand,
	saveOAuthProviderSettings,
} from "../commands/auth";
import {
	runDeviceCodeAuthFlow,
	runOAuthAuthFlow,
} from "../tui/views/onboarding/auth";

const mocks = vi.hoisted(() => ({
	login: vi.fn(),
	device: vi.fn(),
	open: vi.fn(),
}));
vi.mock("@cline/core", async (original) => ({
	...(await original<typeof import("@cline/core")>()),
	loginAndSaveProviderOAuthCredentials: mocks.login,
	loginLocalProvider: mocks.login,
	startClineDeviceAuth: mocks.device,
}));
vi.mock("../utils/open", () => ({ default: mocks.open }));
afterEach(() => {
	vi.clearAllMocks();
	vi.unstubAllGlobals();
});

function fixture() {
	const access = vi.fn(() => {
		throw new Error("Forbidden credential access");
	});
	const manager = new Proxy({}, { get: access }) as ProviderSettingsManager;
	const io = { writeln: vi.fn(), writeErr: vi.fn() };
	vi.stubGlobal(
		"fetch",
		vi.fn(() => {
			throw new Error("Forbidden network");
		}),
	);
	return { access, manager, io };
}
describe("TEST-QB-016/017: CLI cloud auth refusal", () => {
	for (const provider of ["cline", "cline-pass"]) {
		it.each([
			false,
			true,
		])(`${provider} auth command rejects (quick=%s) before settings`, async (quick) => {
			const f = fixture();
			expect(
				await runAuthCommand({
					providerSettingsManager: f.manager,
					io: f.io,
					explicitProvider: provider,
					...(quick ? { apikey: "fixture", modelid: "fixture-model" } : {}),
				}),
			).toBe(1);
			expect(f.io.writeErr).toHaveBeenCalledWith(
				expect.stringContaining("Configure a direct model provider"),
			);
			expect(f.access).not.toHaveBeenCalled();
			expect(mocks.login).not.toHaveBeenCalled();
			expect(fetch).not.toHaveBeenCalled();
		});
		it(`${provider} direct auth and token persistence refuse`, async () => {
			const f = fixture();
			expect(await runAuthProviderCommand(f.manager, provider, f.io)).toBe(1);
			expect(() =>
				saveOAuthProviderSettings(f.manager, provider, undefined, {
					access: "fixture",
					refresh: "fixture",
					expires: 1,
				}),
			).toThrow("Configure a direct model provider");
			expect(f.access).not.toHaveBeenCalled();
			expect(mocks.login).not.toHaveBeenCalled();
		});
		it.each([
			undefined,
			"fixture-token",
		])(`${provider} OAuth ensure rejects even with cached key %s`, async (currentApiKey) => {
			const f = fixture();
			await expect(
				ensureOAuthProviderApiKey({
					providerId: provider,
					currentApiKey,
					providerSettingsManager: f.manager,
					io: f.io,
				}),
			).rejects.toMatchObject({ code: "cline_cloud_disabled" });
			expect(f.access).not.toHaveBeenCalled();
			expect(mocks.login).not.toHaveBeenCalled();
		});
		it(`${provider} ACP refuses before restored credentials`, async () => {
			const f = fixture();
			await expect(
				authenticateAcpProvider(
					provider as Parameters<typeof authenticateAcpProvider>[0],
					f.manager,
				),
			).rejects.toMatchObject({ code: "cline_cloud_disabled" });
			expect(f.access).not.toHaveBeenCalled();
			expect(mocks.login).not.toHaveBeenCalled();
		});
		it.each([
			runOAuthAuthFlow,
			runDeviceCodeAuthFlow,
		])(`${provider} TUI auth gives actionable error`, (flow) => {
			const f = fixture();
			const setError = vi.fn();
			const onComplete = vi.fn();
			expect(() =>
				flow({
					providerId: provider,
					providerSettingsManager: f.manager,
					isAborted: () => false,
					setStatus: vi.fn(),
					setAuthUrl: vi.fn(),
					setUserCode: vi.fn(),
					setVerifyUrl: vi.fn(),
					setError,
					onComplete,
				}),
			).not.toThrow();
			expect(setError).toHaveBeenCalledWith(
				expect.stringContaining("Configure a direct model provider"),
			);
			expect(f.access).not.toHaveBeenCalled();
			expect(mocks.login).not.toHaveBeenCalled();
			expect(mocks.device).not.toHaveBeenCalled();
			expect(mocks.open).not.toHaveBeenCalled();
			expect(onComplete).not.toHaveBeenCalled();
		});
	}
	it("leaves an explicitly supplied direct-provider key alone", async () => {
		const f = fixture();
		await expect(
			ensureOAuthProviderApiKey({
				providerId: "anthropic",
				currentApiKey: "fixture",
				providerSettingsManager: f.manager,
				io: f.io,
			}),
		).resolves.toMatchObject({ apiKey: "fixture" });
		expect(f.access).not.toHaveBeenCalled();
		expect(mocks.login).not.toHaveBeenCalled();
	});
});

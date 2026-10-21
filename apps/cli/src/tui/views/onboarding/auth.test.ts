import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
	loginLocalProvider: vi.fn(),
	startClineDeviceAuth: vi.fn(),
	completeClineDeviceAuth: vi.fn(),
	saveLocalProviderOAuthCredentials: vi.fn(),
	identifyFeatureFlagsAccount: vi.fn(async () => {}),
	openMock: vi.fn(() => Promise.resolve()),
}));

vi.mock("@cline/core", () => ({
	loginLocalProvider: hoisted.loginLocalProvider,
	startClineDeviceAuth: hoisted.startClineDeviceAuth,
	completeClineDeviceAuth: hoisted.completeClineDeviceAuth,
	saveLocalProviderOAuthCredentials: hoisted.saveLocalProviderOAuthCredentials,
	ProviderSettingsManager: class {},
}));

vi.mock("@cline/shared", () => ({
	getClineEnvironmentConfig: () => ({ apiBaseUrl: "https://api.example" }),
}));

vi.mock("../../../utils/open", () => ({ default: hoisted.openMock }));

vi.mock("../../../utils/feature-flags", () => ({
	identifyFeatureFlagsAccount: hoisted.identifyFeatureFlagsAccount,
}));

import { runDeviceCodeAuthFlow, runOAuthAuthFlow } from "./auth";

// Minimal stand-in for a telemetry service. The auth helpers must forward this
// reference verbatim into core; we only need referential equality, so the
// concrete shape doesn't matter for these tests.
const fakeTelemetry = { __id: "fake-telemetry" } as unknown as Parameters<
	typeof runOAuthAuthFlow
>[0]["telemetry"];

function makeManager() {
	return {
		getProviderSettings: vi.fn(() => undefined),
	} as unknown as Parameters<
		typeof runOAuthAuthFlow
	>[0]["providerSettingsManager"];
}

describe("onboarding auth telemetry forwarding", () => {
	beforeEach(() => {
		hoisted.loginLocalProvider.mockReset();
		hoisted.startClineDeviceAuth.mockReset();
		hoisted.completeClineDeviceAuth.mockReset();
		hoisted.saveLocalProviderOAuthCredentials.mockReset();
		hoisted.identifyFeatureFlagsAccount.mockReset();
		hoisted.identifyFeatureFlagsAccount.mockResolvedValue(undefined);
		hoisted.openMock.mockReset();
		hoisted.openMock.mockResolvedValue(undefined);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("forwards the CLI telemetry service into loginLocalProvider", async () => {
		// Resolve the credentials promise so the onComplete branch fires, but the
		// test's assertion is on the telemetry argument passed to core.
		hoisted.loginLocalProvider.mockResolvedValueOnce({
			access: "a",
			refresh: "r",
			expires: 0,
		});

		const onComplete = vi.fn();
		runOAuthAuthFlow({
			providerId: "openai-codex",
			providerSettingsManager: makeManager(),
			isAborted: () => false,
			setStatus: vi.fn(),
			setAuthUrl: vi.fn(),
			setError: vi.fn(),
			onComplete,
			telemetry: fakeTelemetry,
		});

		// Flush the .then chain so we can assert on the post-login callbacks too.
		await Promise.resolve();
		await Promise.resolve();

		expect(hoisted.loginLocalProvider).toHaveBeenCalledTimes(1);
		const [providerArg, , , telemetryArg] =
			hoisted.loginLocalProvider.mock.calls[0];
		expect(providerArg).toBe("openai-codex");
		// Identity, not deep-equal — we are validating the exact reference flows
		// through so opt-out / common metadata stays consistent.
		expect(telemetryArg).toBe(fakeTelemetry);
		expect(hoisted.identifyFeatureFlagsAccount).not.toHaveBeenCalled();
	});

	it("does not pass telemetry when none is provided (back-compat)", () => {
		hoisted.loginLocalProvider.mockResolvedValueOnce({
			access: "a",
			refresh: "r",
			expires: 0,
		});

		runOAuthAuthFlow({
			providerId: "openai-codex",
			providerSettingsManager: makeManager(),
			isAborted: () => false,
			setStatus: vi.fn(),
			setAuthUrl: vi.fn(),
			setError: vi.fn(),
			onComplete: vi.fn(),
		});

		const [, , , telemetryArg] = hoisted.loginLocalProvider.mock.calls[0];
		expect(telemetryArg).toBeUndefined();
	});

	it.each([
		"cline",
		"cline-pass",
	])("refuses %s device auth before settings, browser or telemetry", (providerId) => {
		const manager = makeManager();
		const setError = vi.fn();
		const onComplete = vi.fn();
		runDeviceCodeAuthFlow({
			providerId,
			providerSettingsManager: manager,
			isAborted: () => false,
			setUserCode: vi.fn(),
			setVerifyUrl: vi.fn(),
			setStatus: vi.fn(),
			setError,
			onComplete,
			telemetry: fakeTelemetry,
		});
		expect(setError).toHaveBeenCalledWith(
			expect.stringContaining("Configure a direct model provider"),
		);
		expect(manager.getProviderSettings).not.toHaveBeenCalled();
		expect(hoisted.startClineDeviceAuth).not.toHaveBeenCalled();
		expect(hoisted.completeClineDeviceAuth).not.toHaveBeenCalled();
		expect(hoisted.openMock).not.toHaveBeenCalled();
		expect(hoisted.identifyFeatureFlagsAccount).not.toHaveBeenCalled();
		expect(onComplete).not.toHaveBeenCalled();
	});
	it("leaves an aborted device flow untouched", () => {
		const setError = vi.fn();
		const manager = makeManager();
		runDeviceCodeAuthFlow({
			providerId: "cline",
			providerSettingsManager: manager,
			isAborted: () => true,
			setUserCode: vi.fn(),
			setVerifyUrl: vi.fn(),
			setStatus: vi.fn(),
			setError,
			onComplete: vi.fn(),
		});
		expect(setError).not.toHaveBeenCalled();
		expect(manager.getProviderSettings).not.toHaveBeenCalled();
		expect(hoisted.startClineDeviceAuth).not.toHaveBeenCalled();
	});
});

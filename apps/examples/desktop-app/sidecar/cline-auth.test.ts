// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const access = vi.hoisted(() => ({
	settings: vi.fn(),
	refresh: vi.fn(),
	persisted: vi.fn(),
	environment: vi.fn(),
}));
vi.mock("@cline/core", () => ({
	ProviderSettingsManager: class {
		constructor() {
			access.settings();
		}
		getProviderSettings() {
			access.persisted();
			return { auth: { accountId: "seeded" } };
		}
	},
	RuntimeOAuthTokenManager: class {
		constructor() {
			access.refresh();
		}
		async resolveProviderApiKey() {
			return { apiKey: "seeded-test-token" };
		}
	},
	getProviderAuthHandler: () => ({ getApiKey: access.persisted }),
	captureAuthRefreshSoftFailure: vi.fn(),
	OAuthReauthRequiredError: class extends Error {},
}));
vi.mock("@cline/shared", () => ({
	getClineEnvironmentConfig: () => {
		access.environment();
		return { apiBaseUrl: "https://blocked.invalid" };
	},
}));
import {
	getClineAccountId,
	getClineApiBaseUrl,
	resolveFreshClineAuthToken,
	resolveConnectorsApiAuth,
} from "./cline-auth";
beforeEach(() => vi.clearAllMocks());
afterEach(() => {
	for (const fn of Object.values(access)) expect(fn).not.toHaveBeenCalled();
});
describe("desktop account credential boundary", () => {
	it("rejects account identity without opening settings", () => {
		expect(() => getClineAccountId()).toThrow(/unavailable in cline-qb/);
	});
	it("rejects account endpoint resolution without reading settings or environment", () => {
		expect(() => getClineApiBaseUrl()).toThrow(/unavailable in cline-qb/);
	});
	it("rejects token refresh before runtime manager and persisted fallback", async () => {
		await expect(
			resolveFreshClineAuthToken({
				getProviderSettings: access.persisted,
			} as never),
		).rejects.toThrow(/unavailable in cline-qb/);
	});
	it("rejects connector authentication without identity or token access", async () => {
		await expect(resolveConnectorsApiAuth()).rejects.toThrow(
			/unavailable in cline-qb/,
		);
	});
});

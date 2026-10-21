// SPDX-License-Identifier: Apache-2.0

import type { ProviderSettingsManager } from "@cline/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	fetchClineOrganizations,
	switchClineOrganization,
} from "../acp/organizations";
import { applyInteractiveModelChange } from "../runtime/run-interactive";
import * as account from "../tui/cline-account";
import type { Config } from "./types";

describe("TEST-QB-016/017: reject Cline account boundaries before credential access", () => {
	const forbidden = vi.fn(() => {
		throw new Error("credential access forbidden");
	});
	const manager = new Proxy({}, { get: forbidden }) as ProviderSettingsManager;
	const config = {
		providerId: "cline",
		apiKey: "fixture-inherited-account",
		logger: undefined,
	} as Config;
	const input = {
		config,
		providerSettingsManager: manager,
		get clineProviderSettings(): never {
			return forbidden();
		},
	};
	beforeEach(() => {
		forbidden.mockClear();
		vi.stubGlobal(
			"fetch",
			vi.fn(() => {
				throw new Error("network forbidden");
			}),
		);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});
	const operations: [string, () => Promise<unknown>][] = [
		["account service", () => account.createClineAccountService(input)],
		["account snapshot", () => account.loadClineAccountSnapshot(input)],
		["account switch", () => account.switchClineAccount(input)],
		[
			"subscription plans",
			() => account.loadIndividualSubscriptionPlans(input),
		],
		["current plan", () => account.loadCurrentUserPlan(input)],
		[
			"restored current plan",
			() => account.loadCurrentUserPlanFromProviderSettings(input),
		],
		[
			"restored subscription plans",
			() => account.loadIndividualSubscriptionPlansFromProviderSettings(input),
		],
		[
			"ACP organization lookup",
			() =>
				fetchClineOrganizations({
					apiKey: "fixture",
					providerSettingsManager: manager,
				}),
		],
		[
			"ACP organization switch",
			() =>
				switchClineOrganization({
					apiKey: "fixture",
					providerSettingsManager: manager,
					organizationId: null,
				}),
		],
	];
	it.each(
		operations,
	)("%s rejects without credentials or network", async (_name, operation) => {
		await expect(operation()).rejects.toMatchObject({
			code: "cline_cloud_disabled",
		});
		expect(forbidden).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	});
	it.each([
		"cline",
		"cline-pass",
		" cline ",
		" cline-pass ",
	])("rejects switching to %s before runtime startup", async (providerId) => {
		const ensureReady = vi.fn(async () => {});
		const save = vi.fn();
		await expect(
			applyInteractiveModelChange({
				config: { ...config, providerId },
				providerSettingsManager: {
					getProviderSettings: forbidden,
					saveProviderSettings: save,
				},
				sessionRuntime: {
					ensureReady,
					restartWithCurrentMessages: vi.fn(),
					updateCurrentSessionConnection: vi.fn(),
				},
			}),
		).rejects.toMatchObject({ code: "cline_cloud_disabled" });
		expect(ensureReady).not.toHaveBeenCalled();
		expect(forbidden).not.toHaveBeenCalled();
		expect(save).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	});
	it.each([
		"anthropic",
		"openai",
		"custom-direct",
	])("keeps direct provider %s account-independent", async (providerId) => {
		await expect(
			account.onProviderChange({ config, providerId }),
		).resolves.toBeUndefined();
		expect(forbidden).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	});
});

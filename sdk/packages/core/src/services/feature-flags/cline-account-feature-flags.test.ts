import { FeatureFlag } from "@cline/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	accountId: "account-1" as string | undefined,
	getAllFlagsAndPayloads: vi.fn(),
	dispose: vi.fn(async () => {}),
}));

vi.mock("../storage/provider-settings-manager", () => ({
	ProviderSettingsManager: class {
		getProviderSettings() {
			return { auth: { accountId: mocks.accountId, email: "dev@cline.bot" } };
		}
	},
}));
vi.mock("@cline/core/services/feature-flags/posthog", () => ({
	buildClinePostHogClient: vi.fn(() => ({})),
	PostHogFeatureFlagsProvider: class {
		getAllFlagsAndPayloads = mocks.getAllFlagsAndPayloads;
		dispose = mocks.dispose;
	},
}));

import { isClineAccountFeatureEnabled } from "./cline-account-feature-flags";

afterEach(() => {
	vi.unstubAllEnvs();
	vi.clearAllMocks();
});
describe("Cline account flags are excluded", () => {
	it.each([
		undefined,
		"account-a",
		"account-b",
	])("never queries flags for %s with a legacy telemetry key", async (accountId) => {
		vi.stubEnv("TELEMETRY_SERVICE_API_KEY", "synthetic-legacy-key");
		mocks.accountId = accountId;
		mocks.getAllFlagsAndPayloads.mockResolvedValue({
			featureFlags: { [FeatureFlag.CLINE_COMPOSIO_BETA]: true },
		});
		expect(
			await Promise.all([
				isClineAccountFeatureEnabled(FeatureFlag.CLINE_COMPOSIO_BETA),
				isClineAccountFeatureEnabled(FeatureFlag.CLINE_COMPOSIO_BETA),
			]),
		).toEqual([false, false]);
		mocks.accountId = "different-account";
		expect(
			await isClineAccountFeatureEnabled(FeatureFlag.CLINE_COMPOSIO_BETA),
		).toBe(false);
		expect(mocks.getAllFlagsAndPayloads).not.toHaveBeenCalled();
		expect(mocks.dispose).not.toHaveBeenCalled();
	});
});

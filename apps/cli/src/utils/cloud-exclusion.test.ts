// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const spies = vi.hoisted(() => ({
  configuredTelemetry: vi.fn(), telemetryConfig: vi.fn(), posthog: vi.fn(),
  settings: vi.fn(), account: vi.fn(), distinctId: vi.fn(), flagOptions: vi.fn(),
}));
vi.mock("@cline/core", async () => {
  const actual = await vi.importActual<typeof import("@cline/core")>("@cline/core");
  return {
    ...actual,
    createClineTelemetryServiceConfig: (...args: unknown[]) => { spies.telemetryConfig(...args); return {}; },
    createConfiguredTelemetryHandle: (...args: unknown[]) => {
      spies.configuredTelemetry(...args);
      return { telemetry: new actual.TelemetryService({ deviceId: "fixture" }), dispose: async () => {} };
    },
    resolveCoreDistinctId: () => { spies.distinctId(); return "upstream-distinct-id"; },
    FeatureFlagsService: class extends actual.FeatureFlagsService {
      constructor(options: ConstructorParameters<typeof actual.FeatureFlagsService>[0]) { spies.flagOptions(options); super(options); }
    },
    ProviderSettingsManager: class {
      constructor() { spies.settings(); }
      getProviderSettings() { return { apiKey: "fixture-old-cline-account" }; }
    },
    resolveLocalClineAuthToken: () => "fixture-old-cline-account",
    ClineAccountService: class {
      constructor() { spies.account(); }
      async fetchRemoteConfig() { return { enabled: true, value: "{}" }; }
    },
  };
});
vi.mock("@cline/core/services/feature-flags/posthog", () => ({
  buildClinePostHogClient: () => { spies.posthog(); return {}; },
  PostHogFeatureFlagsProvider: class {
    enabled = true;
    async getAllFlagsAndPayloads() { return {}; }
    getSettings() { return { enabled: true, timeoutMs: 1000 }; }
    async dispose() {}
  },
}));
import { getCliTelemetryService, identifyTelemetryAccount, captureCliExtensionActivated, disposeCliTelemetryService } from "./telemetry";
import { getCliFeatureFlagsService, getCliFeatureFlagsContext, identifyFeatureFlagsAccount, refreshCliFeatureFlagsInBackground, disposeCliFeatureFlagsService } from "./feature-flags";
import { resolveCliSessionMetadata } from "./enterprise";

describe("TEST-QB-016/017: CLI cloud-service exclusion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("TELEMETRY_SERVICE_API_KEY", "fixture-legacy-key");
    vi.stubEnv("IS_TEST", "false"); vi.stubEnv("E2E_TEST", "false");
    vi.stubGlobal("fetch", vi.fn(() => { throw Error("Unexpected network"); }));
  });
  afterEach(async () => {
    await disposeCliTelemetryService(); await disposeCliFeatureFlagsService();
    vi.unstubAllEnvs(); vi.unstubAllGlobals();
  });
  it("never constructs telemetry exporters even with inherited credentials and account metadata", async () => {
    const telemetry = getCliTelemetryService();
    identifyTelemetryAccount({ id: "old-account", email: "old@example.invalid" });
    captureCliExtensionActivated(undefined, { id: "old-account" });
    telemetry.capture({ event: "fixture" }); telemetry.captureRequired("fixture-required"); await telemetry.flush();
    expect(telemetry.isEnabled()).toBe(false);
    expect(spies.telemetryConfig).not.toHaveBeenCalled();
    expect(spies.configuredTelemetry).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("uses local feature defaults without hosted clients, account identity, or legacy cache", async () => {
    const service = getCliFeatureFlagsService();
    await service.poll(); refreshCliFeatureFlagsInBackground();
    await identifyFeatureFlagsAccount({ id: "old-account", email: "old@example.invalid" });
    expect(spies.posthog).not.toHaveBeenCalled();
    expect(spies.distinctId).not.toHaveBeenCalled();
    expect(spies.flagOptions.mock.calls[0][0].cacheFilePath).toBeUndefined();
    expect(getCliFeatureFlagsContext()).toEqual({ clientName: "cline-qb" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not load account remote configuration or upload metadata for new/resumed sessions", async () => {
    expect(await resolveCliSessionMetadata()).toBeUndefined();
    expect(await resolveCliSessionMetadata("legacy-session")).toBeUndefined();
    expect(spies.settings).not.toHaveBeenCalled();
    expect(spies.account).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
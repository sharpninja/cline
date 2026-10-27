import { describe, it, vi } from "vitest";
import {
  assertSelection, cases, createHarness, inputFor,
  type Harness, type ProviderPort, type Selection,
} from "./local-runtime-host.manager-boundary.fixture";

const capture = vi.hoisted(() => ({ harness: undefined as Harness | undefined }));
vi.mock("../../services/storage/provider-settings-manager", () => ({
  ProviderSettingsManager: class {
    constructor() {
      if (!capture.harness) throw new Error("Missing constructor capture harness");
      return capture.harness.dependencies.provider();
    }
  },
}));
vi.mock("../orchestration/runtime-oauth-token-manager", async (importOriginal) => ({
  ...await importOriginal<typeof import("../orchestration/runtime-oauth-token-manager")>(),
  RuntimeOAuthTokenManager: class {
    constructor(options: { providerSettingsManager: ProviderPort }) {
      if (!capture.harness) throw new Error("Missing constructor capture harness");
      return capture.harness.dependencies.oauth(options.providerSettingsManager);
    }
  },
}));
// The real constructor also schedules unrelated detached-log recovery. Capture
// that dependency with a no-I/O response; this proof makes no recovery claim.
vi.mock("../../extensions/tools/executors/bash", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../extensions/tools/executors/bash")>(),
  cleanupStaleDetachedCommandLogs: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../services/telemetry/distinct-id", () => ({
  resolveCoreDistinctId: () => "synthetic-manager-boundary",
}));

import { LocalRuntimeHost } from "./local-runtime-host";

describe("existing LocalRuntimeHost constructor: SAME manager selection assertions", () => {
  for (const fixture of cases) {
    it(fixture.name, () => {
      const harness = createHarness();
      capture.harness = harness;
      const host = new LocalRuntimeHost({
        sessionService: {} as never,
        runtimeBuilder: {} as never,
        ...inputFor(fixture.input, harness),
      } as unknown as ConstructorParameters<typeof LocalRuntimeHost>[0]);
      const observed: Selection = {
        providerSettingsManager: Reflect.get(host, "providerSettingsManager"),
        oauthTokenManager: Reflect.get(host, "oauthTokenManager"),
      };
      assertSelection(fixture, harness, observed);
      console.info("MANAGER_BOUNDARY_CAPTURE " + JSON.stringify({
        name: fixture.name,
        provider: observed.providerSettingsManager.label,
        oauth: observed.oauthTokenManager.label,
        trace: harness.trace,
      }));
      capture.harness = undefined;
    });
  }
});

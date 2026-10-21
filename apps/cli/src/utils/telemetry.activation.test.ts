// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from "vitest";
const calls = vi.hoisted(() => ({ capture: vi.fn(), identify: vi.fn(), configure: vi.fn() }));
vi.mock("@cline/core", () => ({
  captureExtensionActivated: calls.capture, identifyAccount: calls.identify,
  createClineTelemetryServiceConfig: calls.configure,
}));
import { captureCliExtensionActivated, identifyTelemetryAccount, getCliTelemetryService } from "./telemetry";

describe("cline-qb telemetry exclusion", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  it("does not emit an activation event", () => {
    captureCliExtensionActivated(); expect(calls.capture).not.toHaveBeenCalled();
  });
  it("repeated activation cannot activate an exporter", () => {
    for (let i = 0; i < 3; i++) captureCliExtensionActivated();
    expect(calls.capture).not.toHaveBeenCalled(); expect(calls.configure).not.toHaveBeenCalled();
  });
  it("does not forward account metadata during activation", () => {
    captureCliExtensionActivated(undefined, { id: "account", email: "old@example.invalid", organizationId: "org" });
    expect(calls.identify).not.toHaveBeenCalled(); expect(calls.capture).not.toHaveBeenCalled();
  });
  it("does not identify a legacy account", () => {
    identifyTelemetryAccount({ id: "old-account", provider: "cline" });
    expect(calls.identify).not.toHaveBeenCalled();
  });
  it("disables ordinary and required telemetry capture", async () => {
    const service = getCliTelemetryService();
    service.capture({ event: "fixture" }); service.captureRequired("fixture-required");
    await service.flush(); await service.dispose();
    expect(service.isEnabled()).toBe(false);
    expect(calls.configure).not.toHaveBeenCalled(); expect(calls.capture).not.toHaveBeenCalled();
  });
});
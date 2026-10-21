import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
let dataDir: string;
vi.mock("./feature-flags", () => ({
	setDesktopFeatureFlagsAccountContext: vi.fn(),
}));
const mocks = vi.hoisted(() => ({
	capture: vi.fn(),
	configure: vi.fn(),
	handle: vi.fn(),
	identify: vi.fn(),
	providers: vi.fn(),
	device: vi.fn(),
	setLogger: vi.fn(),
	disposeLogger: vi.fn(),
	logger: { debug: vi.fn(), log: vi.fn(), error: vi.fn() },
}));
vi.mock("@cline/core", async () => ({
	...(await vi.importActual<typeof import("@cline/core")>("@cline/core")),
	captureExtensionActivated: mocks.capture,
	createClineTelemetryServiceConfig: mocks.configure,
	createConfiguredTelemetryHandle: mocks.handle,
	identifyAccount: mocks.identify,
	resolveCoreDistinctId: mocks.device,
	ProviderSettingsManager: class {
		constructor() {
			mocks.providers();
		}
		getProviderSettings() {
			return { auth: { accountId: "old-account" } };
		}
	},
	setSdkLogger: mocks.setLogger,
}));
vi.mock("./logging", () => ({
	createDesktopLoggerAdapter: () => ({
		core: mocks.logger,
		dispose: mocks.disposeLogger,
	}),
}));
import { createDesktopObservability } from "./observability";
beforeEach(() => {
	vi.clearAllMocks();
	dataDir = mkdtempSync(join(tmpdir(), "qb-observability-"));
	vi.stubEnv("CLINE_DATA_DIR", dataDir);
	mocks.handle.mockReturnValue({
		telemetry: {
			setDistinctId: vi.fn(),
			setMetadata: vi.fn(),
			updateMetadata: vi.fn(),
			setCommonProperties: vi.fn(),
			updateCommonProperties: vi.fn(),
			capture: vi.fn(),
			captureRequired: vi.fn(),
			recordCounter: vi.fn(),
			recordHistogram: vi.fn(),
			recordGauge: vi.fn(),
			flush: async () => {},
			dispose: async () => {},
			isEnabled: () => true,
		},
		dispose: async () => {},
	});
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(dataDir, { recursive: true, force: true });
});
describe("desktop observability exclusion", () => {
	it("preserves local logging without initializing telemetry or account identity", async () => {
		const state = createDesktopObservability();
		expect(mocks.setLogger).toHaveBeenCalledWith(mocks.logger);
		expect(state.logger).toBe(mocks.logger);
		expect(state.telemetryUser).toBeUndefined();
		state.logger.log("local diagnostic");
		expect(mocks.logger.log).toHaveBeenCalledWith("local diagnostic");
		for (const mock of [
			mocks.configure,
			mocks.handle,
			mocks.capture,
			mocks.identify,
			mocks.providers,
			mocks.device,
		])
			expect(mock).not.toHaveBeenCalled();
		await state.dispose();
		await state.dispose();
		expect(mocks.disposeLogger).toHaveBeenCalledOnce();
		expect(mocks.setLogger).toHaveBeenLastCalledWith(undefined);
	});
	it("all telemetry calls stay inert, including required events and later identity", async () => {
		const state = createDesktopObservability();
		const t = state.telemetry;
		t.setDistinctId("old-account");
		t.setMetadata({});
		t.updateMetadata({});
		t.setCommonProperties({ accountId: "old-account" });
		t.updateCommonProperties({});
		t.capture({ event: "synthetic" });
		t.captureRequired("synthetic", {});
		t.recordCounter("synthetic", 1);
		t.recordHistogram("synthetic", 1);
		t.recordGauge("synthetic", 1);
		await t.flush();
		await t.dispose();
		expect(t.isEnabled()).toBe(false);
		expect(Object.isFrozen(t)).toBe(true);
		for (const mock of [
			mocks.configure,
			mocks.handle,
			mocks.capture,
			mocks.identify,
			mocks.providers,
			mocks.device,
		])
			expect(mock).not.toHaveBeenCalled();
		await state.dispose();
	});
});

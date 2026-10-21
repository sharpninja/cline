import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FEATURE_FLAGS } from "@cline/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
	posthog: vi.fn(),
	device: vi.fn(),
	io: vi.fn(),
}));
vi.mock("@cline/core/services/feature-flags/posthog", () => ({
	buildClinePostHogClient: mocks.posthog,
	PostHogFeatureFlagsProvider: class {
		enabled = true;
		getSettings() {
			return { enabled: true };
		}
		async getAllFlagsAndPayloads() {
			mocks.posthog();
			return { featureFlags: { "code-cloud-agents": true } };
		}
		async dispose() {}
	},
}));
vi.mock("@cline/core", async () => ({
	...(await vi.importActual<typeof import("@cline/core")>("@cline/core")),
	resolveCoreDistinctId: mocks.device,
}));
vi.mock("node:fs", async () => {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	const wrap =
		(name: keyof typeof actual) =>
		(...args: unknown[]) => {
			if (String(args[0]).includes("feature-flags"))
				mocks.io(name, String(args[0]));
			return (actual[name] as (...args: unknown[]) => unknown)(...args);
		};
	return {
		...actual,
		readFileSync: wrap("readFileSync"),
		existsSync: wrap("existsSync"),
		writeFileSync: wrap("writeFileSync"),
		rmSync: wrap("rmSync"),
	};
});
import {
	buildFeatureFlagsSnapshot,
	disposeDesktopFeatureFlagsService,
	getDesktopFeatureFlagsContext,
	getDesktopFeatureFlagsService,
	identifyDesktopFeatureFlagsAccount,
	isCloudAgentsAvailable,
	isCloudAgentsEnabled,
	readCloudAgentsEnvOverride,
	refreshDesktopFeatureFlags,
	resetDesktopFeatureFlagsForTesting,
	setDesktopFeatureFlagsAccountContext,
} from "./feature-flags";
let dir: string;
beforeEach(() => {
	vi.clearAllMocks();
	resetDesktopFeatureFlagsForTesting();
	dir = mkdtempSync(join(tmpdir(), "qb-flags-"));
	vi.stubEnv("CLINE_DATA_DIR", dir);
	vi.stubEnv("IS_TEST", "false");
	vi.stubEnv("E2E_TEST", "false");
	vi.stubEnv("TELEMETRY_SERVICE_API_KEY", "synthetic-key");
	mocks.device.mockReturnValue("old-device");
});
afterEach(async () => {
	await disposeDesktopFeatureFlagsService();
	vi.unstubAllEnvs();
	rmSync(dir, { recursive: true, force: true });
});
describe("desktop hosted flag exclusion", () => {
	it.each([
		undefined,
		"1",
		"true",
		"TRUE",
		"0",
		"false",
		"malformed",
	])("does not enable cloud with override %s", (value) => {
		vi.stubEnv("CLINE_CODE_CLOUD_AGENTS", value);
		expect(readCloudAgentsEnvOverride()).toBe(false);
		expect(isCloudAgentsAvailable()).toBe(false);
		expect(isCloudAgentsEnabled()).toBe(false);
		expect(mocks.posthog).not.toHaveBeenCalled();
		expect(mocks.device).not.toHaveBeenCalled();
	});
	it.each([
		null,
		"{bad",
		JSON.stringify({
			version: 1,
			userId: "old-account",
			email: "old@example.test",
		}),
	])("preserves but never loads legacy identity %s", async (raw) => {
		mkdirSync(join(dir, "cache"), { recursive: true });
		const account = join(dir, "cache", "feature-flags-account.cline-code.json");
		const cache = join(dir, "cache", "feature-flags.cline-code.json");
		const saved = JSON.stringify({
			version: 2,
			updatedAt: Date.now(),
			userId: null,
			flagsPayload: { featureFlags: { "code-cloud-agents": true } },
		});
		if (raw !== null) writeFileSync(account, raw);
		writeFileSync(cache, saved);
		mocks.io.mockClear();
		for (let round = 0; round < 2; round++) {
			expect(getDesktopFeatureFlagsContext()).toEqual({
				clientName: "cline-qb",
			});
			expect(
				setDesktopFeatureFlagsAccountContext({
					id: "new-account",
					email: "new@example.test",
				}),
			).toBe(false);
			await identifyDesktopFeatureFlagsAccount({ id: "other-account" });
			expect(setDesktopFeatureFlagsAccountContext({})).toBe(false);
			const snapshot = await refreshDesktopFeatureFlags();
			expect(Object.keys(snapshot.flags)).toEqual([...FEATURE_FLAGS]);
			expect(Object.values(snapshot.flags).every((x) => x === false)).toBe(
				true,
			);
			await disposeDesktopFeatureFlagsService();
			resetDesktopFeatureFlagsForTesting();
		}
		expect(mocks.io).not.toHaveBeenCalled();
		expect(mocks.posthog).not.toHaveBeenCalled();
		expect(mocks.device).not.toHaveBeenCalled();
		if (raw !== null) expect(readFileSync(account, "utf8")).toBe(raw);
		expect(readFileSync(cache, "utf8")).toBe(saved);
	});
	it("cannot reactivate via cache, context or test mutation; has no telemetry", async () => {
		const telemetry = { capture: vi.fn() } as never;
		const service = getDesktopFeatureFlagsService({ telemetry });
		vi.stubEnv("IS_TEST", "true");
		service.setContext({ userId: "old-account", distinctId: "old-device" });
		service.hydrateCache({
			userId: "old-account",
			updateTime: Date.now(),
			flagsPayload: {
				featureFlags: Object.fromEntries(FEATURE_FLAGS.map((f) => [f, true])),
			},
		});
		for (const flag of FEATURE_FLAGS) {
			service.test(flag, true);
			expect(service.getBooleanFlagEnabled(flag)).toBe(false);
			expect(service.getFlagPayload(flag)).toBe(false);
		}
		await Promise.all([
			service.poll(),
			service.poll("old-account"),
			refreshDesktopFeatureFlags(),
		]);
		expect(service.getCacheSnapshot()).toEqual({ updateTime: 0, userId: null });
		expect(
			Object.values(buildFeatureFlagsSnapshot(service).flags).every(
				(x) => x === false,
			),
		).toBe(true);
		expect(service.enabled).toBe(false);
		expect(mocks.posthog).not.toHaveBeenCalled();
		expect(mocks.device).not.toHaveBeenCalled();
		expect(
			(telemetry as { capture: ReturnType<typeof vi.fn> }).capture,
		).not.toHaveBeenCalled();
	});
	it("shares an inert service and replaces it after idempotent disposal", async () => {
		const first = getDesktopFeatureFlagsService();
		expect(getDesktopFeatureFlagsService()).toBe(first);
		await disposeDesktopFeatureFlagsService();
		await disposeDesktopFeatureFlagsService();
		expect(getDesktopFeatureFlagsService()).not.toBe(first);
		expect(mocks.posthog).not.toHaveBeenCalled();
	});
});

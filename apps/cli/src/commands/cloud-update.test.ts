// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
	spawn: vi.fn(() => ({ unref: vi.fn() })),
	settings: vi.fn(() => true),
	discovery: vi.fn(async () => undefined),
	error: vi.fn(),
	realpath: vi.fn(() => "/fixture/node_modules/cline/bin/cline"),
}));
vi.mock("node:child_process", async (original) => ({
	...(await original<typeof import("node:child_process")>()),
	spawn: calls.spawn,
}));
vi.mock("node:fs", async (original) => ({
	...(await original<typeof import("node:fs")>()),
	realpathSync: calls.realpath,
}));
vi.mock("@cline/core", async (original) => ({
	...(await original<typeof import("@cline/core")>()),
	isAutoUpdateEnabledGlobally: calls.settings,
	readHubDiscovery: calls.discovery,
}));
vi.mock("../utils/output", () => ({
	c: { cyan: "", reset: "", dim: "", bold: "", green: "", yellow: "" },
	writeErr: calls.error,
	writeln: vi.fn(),
}));
beforeEach(() => {
	vi.clearAllMocks();
	vi.stubEnv("IS_DEV", "false");
	vi.stubEnv("CLINE_NO_AUTO_UPDATE", "0");
	vi.stubEnv("CLINE_WRAPPER_PATH", "/fixture/node_modules/cline/bin/cline");
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => {
			throw new Error("blocked network");
		}),
	);
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});
describe("TEST-QB-016/017: upstream update paths", () => {
	it.each([
		true,
		false,
	])("startup ignores legacy auto-update setting %s", async (enabled) => {
		calls.settings.mockReturnValue(enabled);
		const { autoUpdateOnStartup } = await import("./update");
		autoUpdateOnStartup();
		await Promise.resolve();
		expect(fetch).not.toHaveBeenCalled();
		expect(calls.spawn).not.toHaveBeenCalled();
		expect(calls.settings).not.toHaveBeenCalled();
		expect(calls.realpath).not.toHaveBeenCalled();
	});
	it.each([
		{},
		{ includeKanban: false },
		{ includeKanban: true, verbose: true },
	])("manual update refuses before network/install: %j", async (options) => {
		const { checkForUpdates } = await import("./update");
		expect(await checkForUpdates(options)).toBe(1);
		expect(fetch).not.toHaveBeenCalled();
		expect(calls.spawn).not.toHaveBeenCalled();
		expect(calls.realpath).not.toHaveBeenCalled();
		expect(calls.error).toHaveBeenCalledWith(
			expect.stringContaining("matching reviewed cline-qb build"),
		);
	});
	it.each([
		undefined,
		{ command: "echo fixture-install" },
	])("exit cannot execute a pending updater: %j", async (pending) => {
		const { applyDeferredUpdate } = await import("./update");
		expect(await applyDeferredUpdate(pending)).toBe("none");
		expect(calls.spawn).not.toHaveBeenCalled();
		expect(calls.discovery).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	});
});

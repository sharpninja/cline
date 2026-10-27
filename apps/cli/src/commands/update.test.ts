import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	getInstallationInfo,
	getPreferredKanbanInstaller,
	PackageManager,
	resolveCliHubOwnerContext,
} from "./update";

const originalArgv = [...process.argv];
const roots: string[] = [];
function file(suffix: string) {
	const root = mkdtempSync(join(tmpdir(), "qb-install-"));
	roots.push(root);
	const path = join(root, suffix);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, "");
	return path;
}
afterEach(() => {
	process.argv = [...originalArgv];
	vi.unstubAllEnvs();
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
describe("cline-qb installation identity", () => {
	it.each([
		["node_modules/cline-qb/bin/cline-qb", PackageManager.NPM],
		[
			".bun/install/global/node_modules/cline-qb/bin/cline-qb",
			PackageManager.BUN,
		],
		[".pnpm/global/node_modules/cline-qb/bin/cline-qb", PackageManager.PNPM],
		["standalone/cline-qb", PackageManager.UNKNOWN],
	])("detects %s without an upstream install command", (path, manager) => {
		vi.stubEnv("CLINE_QB_WRAPPER_PATH", file(path));
		expect(getInstallationInfo("3.0.0")).toEqual({
			packageName: "cline-qb",
			packageManager: manager,
		});
		expect(
			getInstallationInfo("3.0.0-nightly.123").updateCommand,
		).toBeUndefined();
	});
	it("ignores an inherited upstream wrapper", () => {
		process.argv = ["bun", file("standalone/cline-qb")];
		vi.stubEnv("CLINE_QB_WRAPPER_PATH", "");
		vi.stubEnv("CLINE_WRAPPER_PATH", file("node_modules/cline/bin/cline"));
		expect(getInstallationInfo().packageManager).toBe(PackageManager.UNKNOWN);
	});
	it.each([
		["node_modules/cline-qb/bin/cline-qb", "npm"],
		[".bun/bin/cline-qb", "bun"],
		["standalone/cline-qb", undefined],
	])("retains explicit kanban installer preference for %s", (path, installer) => {
		vi.stubEnv("CLINE_QB_WRAPPER_PATH", file(path as string));
		expect(getPreferredKanbanInstaller()).toBe(installer);
	});
});
it("keeps the existing nonproduction hub owner resolver", () => {
	vi.stubEnv("CLINE_BUILD_ENV", "development");
	vi.stubEnv("CLINE_DATA_DIR", file("data/placeholder"));
	vi.stubEnv("CLINE_HUB_DISCOVERY_PATH", "");
	const owner = resolveCliHubOwnerContext();
	expect(owner.discoveryPath).toContain(sep + join("locks", "hub", "owners") + sep);
});

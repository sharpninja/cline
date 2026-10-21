import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	readDesktopSettings,
	resolveDesktopSettingsPath,
	setCloudSessionsEnabled,
	writeDesktopSettings,
} from "./desktop-settings";
let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "qb-desktop-settings-"));
	vi.stubEnv("CLINE_DATA_DIR", dir);
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(dir, { recursive: true, force: true });
});
describe("desktop cloud settings exclusion", () => {
	it.each([
		null,
		"{bad",
		JSON.stringify({ cloudSessionsEnabled: true }),
		JSON.stringify({ cloudSessionsEnabled: false }),
	])("reports unavailable without mutating saved state %s", (raw) => {
		const path = resolveDesktopSettingsPath();
		if (raw !== null) {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, raw);
		}
		expect(readDesktopSettings()).toEqual({ cloudSessionsEnabled: false });
		expect(() => setCloudSessionsEnabled(true)).toThrow(
			/Cline account services are unavailable/,
		);
		expect(() => writeDesktopSettings({ cloudSessionsEnabled: true })).toThrow(
			/Cline account services are unavailable/,
		);
		expect(setCloudSessionsEnabled(false)).toEqual({
			cloudSessionsEnabled: false,
		});
		writeDesktopSettings({ cloudSessionsEnabled: false });
		if (raw === null) expect(existsSync(path)).toBe(false);
		else expect(readFileSync(path, "utf8")).toBe(raw);
	});
});

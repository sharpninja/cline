// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("TEST-QB-002/053: built storage policy and core service in a real process", () => {
	it.each(["fresh", "legacy"])("keeps %s upstream state untouched", (state) => {
		const home = mkdtempSync(join(tmpdir(), "qb-storage-process-"));
		const upstream = join(home, ".cline", "data", "settings", "providers.json");
		const legacy = JSON.stringify({
			version: 1,
			providers: {
				cline: {
					settings: {
						provider: "cline",
						auth: { accessToken: "fixture-only" },
					},
					updatedAt: "2026-01-01T00:00:00Z",
					tokenSource: "manual",
				},
			},
			modes: {},
			lastUsedProvider: "cline",
		});
		try {
			if (state === "legacy") {
				mkdirSync(dirname(upstream), { recursive: true });
				writeFileSync(upstream, legacy);
			}
			const child = spawnSync(
				process.execPath,
				[
					fileURLToPath(
						new URL("./__fixtures__/storage-process.mjs", import.meta.url),
					),
					home,
				],
				{
					encoding: "utf8",
					timeout: 30000,
					env: {
						PATH: process.env.PATH,
						HOME: home,
						USERPROFILE: home,
						CLINE_DIR: join(home, ".cline"),
						CLINE_DATA_DIR: join(home, ".cline", "data"),
						CLINE_PROVIDER_SETTINGS_PATH: upstream,
					},
				},
			);
			expect(child.error).toBeUndefined();
			expect(child.status, child.stderr).toBe(0);
			const result = JSON.parse(child.stdout.trim());
			expect(result).toMatchObject({
				blocked: 1,
				network: 0,
				providers: ["openai-codex"],
				filePath: join(home, ".cline-qb", "data", "settings", "providers.json"),
			});
			expect(result.hooks).toContain(join(home, ".cline-qb", "Hooks"));
			if (state === "legacy")
				expect(readFileSync(upstream, "utf8")).toBe(legacy);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});

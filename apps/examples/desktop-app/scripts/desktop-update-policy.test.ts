// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../src-tauri");
const base = JSON.parse(readFileSync(join(root, "tauri.conf.json"), "utf8"));
function merge(
	base: Record<string, unknown>,
	overlay: Record<string, unknown>,
): Record<string, unknown> {
	const result = { ...base };
	for (const [key, value] of Object.entries(overlay)) {
		result[key] =
			value && typeof value === "object" && !Array.isArray(value)
				? merge(
						(result[key] ?? {}) as Record<string, unknown>,
						value as Record<string, unknown>,
					)
				: value;
	}
	return result;
}
for (const name of readdirSync(root).filter((name) =>
	/^tauri(?:\..+)?\.conf\.json$/.test(name),
)) {
	test(
		"TEST-QB-016/017: effective desktop config has no updater feed or artifacts: " +
			name,
		() => {
			const overlay = JSON.parse(readFileSync(join(root, name), "utf8"));
			const config = merge(base, overlay) as {
				plugins?: { updater?: { endpoints?: string[] } };
				bundle?: { createUpdaterArtifacts?: boolean };
			};
			expect(config.plugins?.updater?.endpoints ?? []).toEqual([]);
			expect(config.bundle?.createUpdaterArtifacts ?? false).toBe(false);
		},
	);
}
test("TEST-QB-016/017: native updater capability is absent from desktop dependencies", () => {
	expect(readFileSync(join(root, "Cargo.toml"), "utf8")).not.toContain(
		"tauri-plugin-updater",
	);
});

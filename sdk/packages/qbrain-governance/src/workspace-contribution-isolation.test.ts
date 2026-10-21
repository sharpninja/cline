// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const probe = `
import * as paths from '@cline/shared/storage';
import { createQbrainStorageNamespace } from './dist/storage-policy.js';
const [home, workspace] = process.argv.slice(1);
paths.setHomeDir(home);
paths.registerStorageNamespace(createQbrainStorageNamespace({ homeDir: home, env: {} }));
const methods = ['resolveAgentConfigSearchPaths', 'resolveHooksConfigSearchPaths',
  'resolveSkillsConfigSearchPaths', 'resolveRulesConfigSearchPaths',
  'resolveWorkspaceRulesConfigPaths', 'resolveWorkflowsConfigSearchPaths',
  'resolvePluginConfigSearchPaths'];
const results = Object.fromEntries(methods.map(name => {
  try { return [name, { paths: paths[name](workspace) }]; }
  catch (error) { return [name, { error: error.message }]; }
}));
console.log(JSON.stringify(results));
`;

describe("TEST-QB-053: built contribution discovery respects host isolation", () => {
	it.each([
		"absent",
		"seeded",
		"workspace-alias",
		"allowed",
	])("checks %s roots with the actual storage policy", (scenario) => {
		const home = mkdtempSync(join(tmpdir(), "qb-contributions-"));
		const upstream = join(home, ".cline");
		const sentinel = join(upstream, "sentinel.txt");
		let workspace = home;
		try {
			if (scenario !== "absent") {
				mkdirSync(upstream);
				writeFileSync(sentinel, "untouched upstream fixture");
			}
			if (scenario === "workspace-alias" || scenario === "allowed") {
				workspace = join(home, "project");
				mkdirSync(workspace);
				if (scenario === "workspace-alias")
					symlinkSync(upstream, join(workspace, ".cline"), "junction");
			}
			const child = spawnSync(
				process.execPath,
				["--input-type=module", "-e", probe, home, workspace],
				{
					encoding: "utf8",
					timeout: 30000,
				},
			);
			expect(child.error).toBeUndefined();
			expect(child.status, child.stderr).toBe(0);
			const results = JSON.parse(child.stdout.trim()) as Record<
				string,
				{ error?: string; paths?: string[] }
			>;
			expect(Object.keys(results)).toHaveLength(7);
			for (const result of Object.values(results)) {
				if (scenario === "allowed") {
					expect(result.error).toBeUndefined();
					expect(result.paths?.length).toBeGreaterThan(0);
				} else {
					expect(result.error).toMatch(/upstream Cline/);
					expect(result.paths).toBeUndefined();
				}
			}
			if (scenario === "allowed") {
				expect(results.resolveRulesConfigSearchPaths?.paths).toContain(
					join(workspace, ".clinerules"),
				);
				expect(results.resolveWorkflowsConfigSearchPaths?.paths).toContain(
					join(workspace, ".clinerules", "workflows"),
				);
				expect(results.resolveSkillsConfigSearchPaths?.paths).toContain(
					join(workspace, ".agents", "skills"),
				);
				expect(results.resolveSkillsConfigSearchPaths?.paths).toContain(
					join(home, ".agents", "skills"),
				);
			}
			if (scenario !== "absent")
				expect(readFileSync(sentinel, "utf8")).toBe(
					"untouched upstream fixture",
				);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});

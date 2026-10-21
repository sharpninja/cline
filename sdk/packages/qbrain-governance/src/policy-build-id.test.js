// SPDX-License-Identifier: Apache-2.0
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { resolveGovernanceBuildDigest } from "../scripts/policy-build-id.mjs";

const roots = [];
const privateRoot = "sdk/packages/qbrain-governance";
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
function put(root, path, value = "fixture") {
	const target = join(root, path);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, value);
}
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "qb-build-identity-"));
	roots.push(root);
	put(root, "bun.lock");
	for (const name of ["shared", "llms", "agents", "core"]) {
		put(root, `sdk/packages/${name}/package.json`);
		put(root, `sdk/packages/${name}/src/index.ts`);
	}
	for (const file of [
		"src/index.ts",
		"scripts/policy-build-id.mjs",
		"package.json",
		"bun.mts",
		"tsconfig.json",
		"tsconfig.build.json",
		"vendor/qbrainai-qbrain-ai-plugin-core.tgz",
	])
		put(root, `${privateRoot}/${file}`);
	return root;
}
it("is deterministic across checkout locations and contains no workspace identity", () => {
	const a = fixture(),
		b = fixture();
	expect(resolveGovernanceBuildDigest(a)).toMatch(/^[a-f0-9]{64}$/);
	expect(resolveGovernanceBuildDigest(a)).toBe(resolveGovernanceBuildDigest(b));
	put(a, "AGENTS-README-FIRST.yaml", "workspace marker must not be read");
	expect(resolveGovernanceBuildDigest(a)).toBe(resolveGovernanceBuildDigest(b));
});
it.each([
	"bun.lock",
	"sdk/packages/core/src/index.ts",
	"sdk/packages/shared/src/index.ts",
	"sdk/packages/llms/src/index.ts",
	"sdk/packages/agents/src/index.ts",
	`${privateRoot}/src/index.ts`,
	`${privateRoot}/scripts/policy-build-id.mjs`,
	`${privateRoot}/package.json`,
	`${privateRoot}/bun.mts`,
	`${privateRoot}/tsconfig.json`,
	`${privateRoot}/vendor/qbrainai-qbrain-ai-plugin-core.tgz`,
])("changes with enforcement input %s", (path) => {
	const root = fixture();
	const before = resolveGovernanceBuildDigest(root);
	put(root, path, "different bytes");
	expect(resolveGovernanceBuildDigest(root)).not.toBe(before);
});
it("excludes test-only source changes", () => {
	const root = fixture();
	const before = resolveGovernanceBuildDigest(root);
	put(root, `${privateRoot}/src/new.test.ts`);
	put(root, `${privateRoot}/src/__tests__/fixture.ts`);
	expect(resolveGovernanceBuildDigest(root)).toBe(before);
});
it.each([
	"bun.lock",
	`${privateRoot}/vendor/qbrainai-qbrain-ai-plugin-core.tgz`,
	`${privateRoot}/bun.mts`,
])("refuses missing required input %s", (path) => {
	const root = fixture();
	rmSync(join(root, path));
	expect(() => resolveGovernanceBuildDigest(root)).toThrow();
});
it("refuses source symlinks instead of silently omitting enforcement", () => {
	const root = fixture();
	symlinkSync(join(root, "bun.lock"), join(root, privateRoot, "src/linked.ts"));
	expect(() => resolveGovernanceBuildDigest(root)).toThrow(/regular files/);
});

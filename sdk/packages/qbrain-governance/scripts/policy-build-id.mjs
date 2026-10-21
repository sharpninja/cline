// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { resolveSdkRuntimeBuildId } from "../../core/scripts/runtime-build-id.ts";

const excludedDirectories = new Set(["__tests__", "fixtures", "tests"]);
function collect(directory) {
	const files = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
		const path = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...collect(path));
		else if (entry.isFile()) {
			if (!/\.(?:test|spec)(?:\.[^.]+)?\.[cm]?[jt]sx?$/.test(entry.name))
				files.push(path);
		} else
			throw new Error(
				"Governance build inputs must be regular files or directories.",
			);
	}
	return files;
}

/** Build-time only. Never hash a user's workspace or read a runtime override. */
export function resolveGovernanceBuildDigest(repoRoot) {
	const packageRoot = join(repoRoot, "sdk/packages/qbrain-governance");
	const hash = createHash("sha256").update("cline-qb-governance-build-v1\0");
	hash.update(resolveSdkRuntimeBuildId(repoRoot)).update("\0");
	const inputs = [
		"package.json",
		"bun.mts",
		"tsconfig.json",
		"tsconfig.build.json",
		"vendor/qbrainai-qbrain-ai-plugin-core.tgz",
	].map((path) => join(packageRoot, path));
	inputs.push(
		...collect(join(packageRoot, "src")),
		...collect(join(packageRoot, "scripts")),
	);
	for (const path of inputs.sort()) {
		hash.update(relative(repoRoot, path).replaceAll("\\", "/")).update("\0");
		hash.update(readFileSync(path)).update("\0");
	}
	return hash.digest("hex");
}

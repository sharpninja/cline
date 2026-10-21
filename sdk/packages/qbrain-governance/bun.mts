/// <reference types="@types/bun" />
// SPDX-License-Identifier: Apache-2.0
import { resolve } from "node:path";
import { resolveGovernanceBuildDigest } from "./scripts/policy-build-id.mjs";

const result = await Bun.build({
	entrypoints: [
		"./src/index.ts",
		"./src/cloud-policy.ts",
		"./src/storage-policy.ts",
		"./src/host-storage.ts",
		"./src/hub-namespace.ts",
	],
	outdir: "./dist",
	target: "node",
	external: ["@cline/shared"],
	define: {
		__CLINE_QB_GOVERNANCE_BUILD_DIGEST__: JSON.stringify(
			resolveGovernanceBuildDigest(resolve(import.meta.dir, "../../..")),
		),
	},
});
if (!result.success) {
	for (const log of result.logs) console.error(log);
	process.exit(1);
}

// VS Code's compiled Mocha consumers use require(); retain the native Node runtime.
const commonJsResult = await Bun.build({
	entrypoints: ["./src/cloud-policy.ts"],
	outdir: "./dist",
	target: "node",
	format: "cjs",
	naming: "[name].cjs",
});
if (!commonJsResult.success) {
	for (const log of commonJsResult.logs) console.error(log);
	process.exit(1);
}

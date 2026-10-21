// SPDX-License-Identifier: Apache-2.0
import qbrainBuildDefines from "../../../qbrain-build-defines.json" with {
	type: "json",
};

async function main(): Promise<void> {
	const result = await Bun.build({
		entrypoints: ["./sidecar/index.ts"],
		outdir: "./dist/sidecar",
		target: "bun",
		format: "esm",
		env: "disable",
		define: qbrainBuildDefines,
	});
	if (!result.success)
		throw new AggregateError(result.logs, "Desktop sidecar build failed");
}
void main().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});

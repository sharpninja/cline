import esbuild from "esbuild";
import qbrainBuildDefines from "../qbrain-build-defines.json" with {
	type: "json",
};

const production = process.argv.includes("--production");

await esbuild.build({
	entryPoints: ["src/extension.ts"],
	bundle: true,
	outfile: "dist/extension.js",
	platform: "node",
	format: "cjs",
	target: "node18",
	external: ["vscode"],
	minify: production,
	sourcemap: !production,
	define: qbrainBuildDefines,
	logLevel: "info",
});

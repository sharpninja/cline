import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import qbrainBuildDefines from "../../../qbrain-build-defines.json" with {
	type: "json",
};
import { telemetryDefineArgs } from "./telemetry-define-args";

function defineMap(args: string[]): Record<string, string> {
	const map: Record<string, string> = {};
	for (let index = 0; index < args.length; index += 2) {
		expect(args[index]).toBe("--define");
		const pair = args[index + 1];
		const separator = pair.indexOf("=");
		map[pair.slice(0, separator)] = pair.slice(separator + 1);
	}
	return map;
}

describe("TEST-QB-016/017/055: disabled build-time telemetry", () => {
	it("inlines empty OTEL values even when exporter settings are supplied", () => {
		const env = {
			OTEL_TELEMETRY_ENABLED: "1",
			OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.invalid:4318",
			OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
			OTEL_EXPORTER_OTLP_HEADERS: "x-api-key=synthetic",
			OTEL_LOGS_EXPORTER: "otlp",
			OTEL_METRICS_EXPORTER: "otlp",
			OTEL_TRACES_EXPORTER: "otlp",
			OTEL_METRIC_EXPORT_INTERVAL: "60000",
		};
		const defines = defineMap(telemetryDefineArgs(env));
		for (const key of Object.keys(env))
			expect(defines[`process.env.${key}`]).toBe('""');
	});
	it("inlines unset OTEL values as empty strings without runtime fallback", () => {
		const defines = defineMap(telemetryDefineArgs({}));
		expect(defines["process.env.OTEL_TELEMETRY_ENABLED"]).toBe('""');
		expect(defines["process.env.OTEL_EXPORTER_OTLP_ENDPOINT"]).toBe('""');
	});
	it("inlines empty telemetry and error keys whether supplied or absent", () => {
		for (const env of [
			{},
			{
				TELEMETRY_SERVICE_API_KEY: "synthetic-tk",
				ERROR_SERVICE_API_KEY: "synthetic-ek",
			},
		]) {
			const defines = defineMap(telemetryDefineArgs(env));
			expect(defines["process.env.TELEMETRY_SERVICE_API_KEY"]).toBe('""');
			expect(defines["process.env.ERROR_SERVICE_API_KEY"]).toBe('""');
		}
	});
	it("cannot enable cloud agents from build-time settings", () => {
		for (const env of [{}, { CLINE_CODE_CLOUD_AGENTS: "1" }])
			expect(
				defineMap(telemetryDefineArgs(env))[
					"process.env.CLINE_CODE_CLOUD_AGENTS"
				],
			).toBe('""');
	});
	it("discards quoted header content instead of embedding it", () => {
		const defines = defineMap(
			telemetryDefineArgs({
				OTEL_EXPORTER_OTLP_HEADERS: 'x-quote="synthetic",y=2',
			}),
		);
		expect(defines["process.env.OTEL_EXPORTER_OTLP_HEADERS"]).toBe('""');
	});
	it("does not inspect supplied environment values", () => {
		const env = new Proxy(
			{},
			{
				get() {
					throw new Error("Environment must not be read");
				},
			},
		);
		expect(() => telemetryDefineArgs(env)).not.toThrow();
	});
});

// Compile real probes under both bundlers. Build-time and runtime values are
// populated independently so missing defines or env inlining cannot pass.
const prohibitedNames = [
	"TELEMETRY_SERVICE_API_KEY",
	"ERROR_SERVICE_API_KEY",
	"CLINE_CODE_CLOUD_AGENTS",
	"ENABLE_ERROR_AUTOCAPTURE",
	"OTEL_TELEMETRY_ENABLED",
	"OTEL_METRICS_EXPORTER",
	"OTEL_LOGS_EXPORTER",
	"OTEL_TRACES_EXPORTER",
	"OTEL_EXPORTER_OTLP_PROTOCOL",
	"OTEL_EXPORTER_OTLP_ENDPOINT",
	"OTEL_EXPORTER_OTLP_HEADERS",
	"OTEL_METRIC_EXPORT_INTERVAL",
	"OTEL_SERVICE_NAME",
	"CLINE_TRACE_SAMPLE_PERCENT",
	"CLINE_TRACE_RECORD_CONTENT",
	"LANGFUSE_BASE_URL",
	"LANGFUSE_PUBLIC_KEY",
	"LANGFUSE_SECRET_KEY",
] as const;
it.each([
	"bun",
	"esbuild",
])("TEST-QB-055: %s artifacts contain no supplied configuration and ignore runtime overrides", async (bundler) => {
	const dir = mkdtempSync(join(tmpdir(), "qb-build-env-"));
	try {
		const entry = join(dir, "probe.js");
		const output = join(dir, "output.mjs");
		const buildEnv = Object.fromEntries(
			prohibitedNames.map((name) => [name, `QB_SYNTHETIC_BUILD_${name}`]),
		);
		const runtimeEnv = Object.fromEntries(
			prohibitedNames.map((name) => [name, `QB_SYNTHETIC_RUNTIME_${name}`]),
		);
		writeFileSync(
			entry,
			`console.log(JSON.stringify([${prohibitedNames.map((name) => `process.env.${name}`).join(",")}]))`,
		);
		if (bundler === "bun") {
			const build = spawnSync(
				"bun",
				[
					"build",
					entry,
					"--target=node",
					"--env=disable",
					...telemetryDefineArgs(buildEnv),
					"--outfile",
					output,
				],
				{
					encoding: "utf8",
					timeout: 60_000,
					env: { ...process.env, ...buildEnv },
				},
			);
			expect(build.status, build.stderr).toBe(0);
		} else {
			const require = createRequire(
				new URL("../../../vscode/esbuild.mjs", import.meta.url),
			);
			const esbuild = require("esbuild") as {
				build(options: Record<string, unknown>): Promise<unknown>;
			};
			await esbuild.build({
				entryPoints: [entry],
				outfile: output,
				bundle: true,
				platform: "node",
				format: "esm",
				define: qbrainBuildDefines,
			});
		}
		const bytes = readFileSync(output, "utf8");
		expect(bytes).not.toContain("QB_SYNTHETIC_BUILD_");
		const run = spawnSync("node", [output], {
			encoding: "utf8",
			timeout: 30_000,
			env: { ...process.env, ...runtimeEnv },
		});
		expect(run.status, run.stderr).toBe(0);
		expect(JSON.parse(run.stdout)).toEqual(prohibitedNames.map(() => ""));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

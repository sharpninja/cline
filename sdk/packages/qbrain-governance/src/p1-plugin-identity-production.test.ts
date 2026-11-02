// SPDX-License-Identifier: Apache-2.0
/**
 * Actual private-bootstrap adapter for the frozen independent identity oracle.
 * It reads input only, writes synthetic task-owned archives/markers, calls the
 * original verifier/parser/installer/loader, and retains full dependency traces.
 * Change log:
 * - 2026-11-02 | FR-QB-001, FR-QB-002; TR-QB-PLUGIN-001, TR-QB-TRUST-001;
 *   TEST-QB-003, TEST-QB-004;
 *   AC-QB-BLOCKS-EXECUTION-WHEN-REQUIRED-PLUGIN-IS-UNUSABLE,
 *   AC-QB-FAILS-CLOSED-ON-WORKSPACE-TRUST-FAILURE | Bind SAME14 cases without
 *   changing the approved oracle or activating any real S/P runtime artifact.
 */
import assert, { AssertionError } from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, vi } from "vitest";
import { pluginIdentityScenarios } from "./__fixtures__/p1-plugin-identity-cases";
import type {
	PluginIdentityBinding,
	PluginIdentityInput,
	PluginIdentityObservation,
} from "./__fixtures__/p1-plugin-identity-contract";
import { assertPluginIdentity } from "./__fixtures__/p1-plugin-identity-contract";

/** Full actual calls are evidence; the frozen assertion projects named boundaries. */
interface Capture {
	operations: string[];
	calls: { boundary: string; detail: unknown }[];
	effects: string[];
	parsingArchive: boolean;
	perturbation?: Perturbation;
}
type Perturbation =
	| "wrong-nonce"
	| "health-error"
	| "marker-race"
	| "wrong-workspace"
	| "tampered-artifact"
	| "installed-byte-change";
const capture = vi.hoisted(() => ({
	active: undefined as Capture | undefined,
}));

// Call through to the real baseline package; no expected records are available here.
vi.mock("@qbrainai/qbrain-ai-plugin-core", async (importOriginal) => {
	const original =
		await importOriginal<typeof import("@qbrainai/qbrain-ai-plugin-core")>();
	return {
		...original,
		verifyPinnedPluginArtifact(
			options: Parameters<typeof original.verifyPinnedPluginArtifact>[0],
		) {
			capture.active?.operations.push("artifact.verify");
			capture.active?.calls.push({
				boundary: "artifact.verify",
				detail: { ...options, binding: { ...options.binding } },
			});
			return original.verifyPinnedPluginArtifact(options);
		},
		async fullBootstrap(...args: Parameters<typeof original.fullBootstrap>) {
			capture.active?.operations.push("marker.authenticate");
			capture.active?.calls.push({
				boundary: "marker.authenticate",
				detail: { workspace: args[0], binding: args[1]?.requiredAgentPlugin },
			});
			const value = await original.fullBootstrap(...args);
			// Retain authenticated public binding only; never emit even synthetic key/signature.
			capture.active?.calls.push({
				boundary: "marker.authenticated",
				detail: value.agentPluginContract,
			});
			return value;
		},
	};
});
vi.mock("./plugin-installation", async (importOriginal) => {
	const original =
		await importOriginal<typeof import("./plugin-installation")>();
	return {
		...original,
		async preparePluginInstallation(
			options: Parameters<typeof original.preparePluginInstallation>[0],
		) {
			const active = capture.active;
			if (!active) throw new Error("Missing actual identity capture");
			active.calls.push({
				boundary: "archive.prepare",
				detail: {
					binding: options.binding,
					requiredFiles: options.requiredFiles,
					bytesSHA256: createHash("sha256").update(options.bytes).digest("hex"),
				},
			});
			active.parsingArchive = true;
			let prepared: Awaited<
				ReturnType<typeof original.preparePluginInstallation>
			>;
			try {
				prepared = await original.preparePluginInstallation(options);
			} finally {
				active.parsingArchive = false;
			}
			return {
				...prepared,
				install(parentDirectory: string) {
					active.operations.push("plugin.install");
					const installed = prepared.install(parentDirectory);
					active.calls.push({
						boundary: "plugin.installed",
						detail: {
							root: installed.root,
							binding: installed.binding,
							fileCount: prepared.fileCount,
						},
					});
					if (active.perturbation === "installed-byte-change") {
						writeFileSync(
							join(installed.root, "dist/host.js"),
							"throw new Error('synthetic tampered bytes');",
						);
						active.calls.push({
							boundary: "control.activated",
							detail: active.perturbation,
						});
					}
					return installed;
				},
			};
		},
	};
});

import { bootstrapGovernedPlugin } from "./trusted-plugin-bootstrap";

/**
 * Sign only the supplied synthetic binding in a private test workspace.
 * @param root - Task-owned directory, never an operator workspace or home.
 * @param binding - Independently supplied signed authority, not expected output.
 * @param workspacePath - Optional deliberate foreign-workspace negative control.
 * @returns The synthetic marker path.
 * @throws {Error} If private fixture serialization or writing fails.
 */
function writeSignedMarker(
	root: string,
	binding: PluginIdentityBinding,
	workspacePath = root,
): string {
	const contract = {
		source_type: binding.agentName,
		plugin_name: binding.pluginName,
		plugin_version: binding.pluginVersion,
		activation: "Required",
		startup_command: "",
		unavailable_failure: "MCP_PLUGIN_UNAVAILABLE:ClineQb",
		required_env_vars: [],
		hook_expectations: [],
		tool_expectations: [],
		root_hints: [],
		artifact_sha256: binding.artifactSha256,
	};
	const fields = [
		["sourceType", "source_type"],
		["pluginName", "plugin_name"],
		["pluginVersion", "plugin_version"],
		["activation", "activation"],
		["startupCommand", "startup_command"],
		["unavailableFailure", "unavailable_failure"],
		["requiredEnvVars", "required_env_vars"],
		["hookExpectations", "hook_expectations"],
		["toolExpectations", "tool_expectations"],
		["rootHints", "root_hints"],
	] as const;
	const contractText =
		[
			"policy=required",
			...fields.map(
				([wire, key]) =>
					`ClineQb.${wire}=${Array.isArray(contract[key]) ? contract[key].join(",") : contract[key]}`,
			),
			`ClineQb.artifactSha256=${binding.artifactSha256}`,
		].join("\n") + "\n";
	const digest = createHash("sha256")
		.update(contractText)
		.digest("hex")
		.toUpperCase();
	const marker: Record<string, unknown> = {
		port: 7147,
		baseUrl: "http://127.0.0.1:7147",
		apiKey: "synthetic-identity-only-key",
		workspace: "identity-fixture",
		workspacePath,
		pid: 123,
		startedAt: "2026-01-01T00:00:00Z",
		markerWrittenAtUtc: "2026-01-01T00:00:00Z",
		serverStartedAtUtc: "2026-01-01T00:00:00Z",
		endpoints: { health: "/health" },
		agent_plugins: {
			policy: "required",
			contract_digest: digest,
			agents: { ClineQb: contract },
		},
	};
	const signed =
		[
			"canonicalization=marker-v1",
			...[
				"port",
				"baseUrl",
				"apiKey",
				"workspace",
				"workspacePath",
				"pid",
				"startedAt",
				"markerWrittenAtUtc",
				"serverStartedAtUtc",
			].map((key) => `${key}=${marker[key]}`),
			"endpoints.health=/health",
			"agentPlugins.policy=required",
			`agentPlugins.contractDigest=${digest}`,
		].join("\n") + "\n";
	marker.signature = {
		algorithm: "HMAC-SHA256",
		canonicalization: "marker-v1",
		value: createHmac("sha256", "synthetic-identity-only-key")
			.update(signed)
			.digest("hex")
			.toUpperCase(),
	};
	const path = join(root, "AGENTS-README-FIRST.yaml");
	writeFileSync(path, JSON.stringify(marker));
	return path;
}

/**
 * Exercise actual private bootstrap from input only and observe actual boundaries.
 * @param input - Frozen scenario input; never the scenario or expected object.
 * @param perturbation - Optional real dependency/filesystem failure to qualify rejection.
 * @returns Full captured observation and raw dependency/filesystem evidence.
 * @throws {Error} Setup/instrumentation failures propagate and cannot count as rejection.
 * @remarks Retains task-owned fixture files for evidence; does not clean operator state.
 */
async function runActualIdentity(
	input: PluginIdentityInput,
	perturbation?: Perturbation,
) {
	const root = mkdtempSync(join(tmpdir(), "qb-nov2-identity-"));
	const parent = join(root, "private");
	mkdirSync(parent);
	const artifactPath = join(root, "synthetic.tar");
	writeFileSync(artifactPath, input.archiveBytes);
	writeSignedMarker(
		root,
		input.signedBinding,
		perturbation === "wrong-workspace" ? join(root, "foreign") : root,
	);
	const active: Capture = {
		operations: ["host.identity"],
		calls: [],
		effects: [],
		parsingArchive: false,
		perturbation,
	};
	capture.active = active;
	if (perturbation === "wrong-workspace")
		active.calls.push({ boundary: "control.activated", detail: perturbation });
	if (perturbation === "tampered-artifact") {
		writeFileSync(artifactPath, "synthetic altered archive");
		active.calls.push({ boundary: "control.activated", detail: perturbation });
	}
	const observer = Symbol.for("qbrain.test.plugin-identity-observer");
	const oldObserver = Object.getOwnPropertyDescriptor(globalThis, observer);
	Object.defineProperty(globalThis, observer, {
		configurable: true,
		value: (event: string) => {
			active.effects.push(event);
			if (event === "plugin.import") active.operations.push(event);
		},
	});
	vi.stubGlobal("__CLINE_QB_GOVERNANCE_BUILD_DIGEST__", "a".repeat(64));
	const parse = JSON.parse;
	const parseSpy = vi
		.spyOn(JSON, "parse")
		.mockImplementation((...args: Parameters<typeof JSON.parse>) => {
			const value: unknown = parse(...args);
			if (
				active.parsingArchive &&
				value &&
				typeof value === "object" &&
				"name" in value &&
				"version" in value
			) {
				active.operations.push("manifest.read");
				active.calls.push({
					boundary: "manifest.read",
					detail: structuredClone(value),
				});
				return new Proxy(value, {
					get(target, key, receiver) {
						if (key === "qbrainAiLegacyName")
							active.effects.push("legacy.alias.lookup");
						return Reflect.get(target, key, receiver);
					},
				});
			}
			return value;
		});
	const fetcher: typeof fetch = async (url) => {
		const target = new URL(String(url));
		// This dependency never opens a socket. Record only public nonce/routing evidence.
		active.calls.push({
			boundary: "health.fetch",
			detail: {
				origin: target.origin,
				pathname: target.pathname,
				nonce: target.searchParams.get("nonce"),
			},
		});
		if (perturbation === "health-error") {
			active.calls.push({
				boundary: "control.activated",
				detail: perturbation,
			});
			throw new Error("Synthetic health failure");
		}
		if (perturbation === "marker-race") {
			writeSignedMarker(root, {
				...input.signedBinding,
				artifactSha256: "c".repeat(64),
			});
			active.calls.push({
				boundary: "control.activated",
				detail: perturbation,
			});
		}
		if (perturbation === "wrong-nonce")
			active.calls.push({
				boundary: "control.activated",
				detail: perturbation,
			});
		return Response.json({
			nonce:
				perturbation === "wrong-nonce"
					? "synthetic-wrong-nonce"
					: target.searchParams.get("nonce"),
		});
	};
	let observation: PluginIdentityObservation;
	try {
		try {
			const ready = await bootstrapGovernedPlugin({
				workspacePath: root,
				artifactPath,
				binding: input.hostPin,
				parentDirectory: parent,
				fetch: fetcher,
			});
			const actual = ready.contract;
			observation = {
				outcome: "ready",
				operations: active.operations,
				acceptedBinding: {
					agentName: actual.agentName,
					pluginName: actual.pluginName,
					pluginVersion: actual.pluginVersion,
					artifactSha256: actual.artifactSha256,
				},
				imports: active.effects.filter((event) => event === "plugin.import")
					.length,
				ordinaryExecutions: active.effects.filter(
					(event) => event === "ordinary.execute",
				).length,
				aliasFallbacks: active.effects.filter(
					(event) => event === "legacy.alias.lookup",
				).length,
				diagnostic: null,
				exercisedFaults: [],
			};
		} catch (error) {
			if (
				!(error instanceof Error) ||
				error.message !==
					"Governed plugin startup requires authenticated workspace trust and the exact reviewed artifact."
			)
				throw error;
			observation = {
				outcome: "blocked",
				operations: active.operations,
				acceptedBinding: null,
				imports: active.effects.filter((event) => event === "plugin.import")
					.length,
				ordinaryExecutions: active.effects.filter(
					(event) => event === "ordinary.execute",
				).length,
				aliasFallbacks: active.effects.filter(
					(event) => event === "legacy.alias.lookup",
				).length,
				diagnostic: error.message,
				exercisedFaults: [],
			};
		}
	} finally {
		parseSpy.mockRestore();
		if (oldObserver) Object.defineProperty(globalThis, observer, oldObserver);
		else Reflect.deleteProperty(globalThis, observer);
		capture.active = undefined;
	}
	return {
		observation,
		calls: active.calls,
		effects: active.effects,
		root,
		parentEntries: readdirSync(parent),
		artifactSHA256: createHash("sha256")
			.update(readFileSync(artifactPath))
			.digest("hex"),
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	capture.active = undefined;
});
describe("P1 SAME14 actual private package identity", () => {
	for (const scenario of pluginIdentityScenarios)
		it(scenario.id, async () => {
			const input = structuredClone(scenario.input);
			const before = structuredClone(input);
			const result = await runActualIdentity(input);
			assertPluginIdentity(scenario, result.observation);
			assert.deepStrictEqual(result.observation.exercisedFaults, []);
			assert.deepStrictEqual(input, before, "PLUGIN_IDENTITY: input mutated");
			console.log(
				JSON.stringify({
					scenario: scenario.id,
					actualPrivateBootstrap: true,
					acceptedDependencyArtifact: false,
					...result,
				}),
			);
		});
	const positive = pluginIdentityScenarios[0]!;
	for (const perturbation of [
		"wrong-nonce",
		"health-error",
		"marker-race",
		"wrong-workspace",
		"tampered-artifact",
		"installed-byte-change",
	] as const)
		it(
			"SAME assertions reject actual boundary control/" + perturbation,
			async () => {
				const input = structuredClone(positive.input);
				const before = structuredClone(input);
				const result = await runActualIdentity(input, perturbation);
				assert(
					result.calls.some(
						(call) =>
							call.boundary === "control.activated" &&
							call.detail === perturbation,
					),
					"Actual control was not exercised",
				);
				assert.equal(
					result.observation.outcome,
					"blocked",
					"Actual failure was not contained",
				);
				assert.throws(
					() => assertPluginIdentity(positive, result.observation),
					(error) =>
						error instanceof AssertionError &&
						error.code === "ERR_ASSERTION" &&
						error.message.startsWith("PLUGIN_IDENTITY:"),
				);
				assert.deepStrictEqual(
					input,
					before,
					"PLUGIN_IDENTITY: control input mutated",
				);
				console.log(
					JSON.stringify({
						scenario: positive.id,
						perturbation,
						intendedAssertionRejected: true,
						actualPrivateBootstrap: true,
						...result,
					}),
				);
			},
		);
});

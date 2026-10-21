// SPDX-License-Identifier: Apache-2.0
import { createHash, createHmac } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Header } from "tar";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	bootstrapGovernedPlugin,
	type TrustedPluginBootstrapOptions,
} from "./trusted-plugin-bootstrap";

const roots: string[] = [];
const state = globalThis as typeof globalThis & {
	qbTrustImports?: number;
	qbTrustFactories?: number;
};
beforeEach(() => {
	vi.stubGlobal("__CLINE_QB_GOVERNANCE_BUILD_DIGEST__", "a".repeat(64));
	state.qbTrustImports = 0;
	state.qbTrustFactories = 0;
});
afterEach(() => {
	vi.unstubAllGlobals();
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
	delete state.qbTrustImports;
	delete state.qbTrustFactories;
});

function signedMarker(
	root: string,
	binding: TrustedPluginBootstrapOptions["binding"],
	change: { workspacePath?: string; activation?: string } = {},
) {
	const contract: Record<string, string | string[]> = {
		source_type: "ClineQb",
		plugin_name: binding.pluginName,
		plugin_version: binding.pluginVersion,
		activation: change.activation ?? "Required",
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
		apiKey: "synthetic-test-key",
		workspace: "test",
		workspacePath: change.workspacePath ?? root,
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
	const text =
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
		value: createHmac("sha256", "synthetic-test-key")
			.update(text)
			.digest("hex")
			.toUpperCase(),
	};
	writeFileSync(join(root, "AGENTS-README-FIRST.yaml"), JSON.stringify(marker));
}

function fixture(pluginComment = "") {
	const root = mkdtempSync(join(tmpdir(), "qb-trust-"));
	roots.push(root);
	const parent = join(root, "private");
	mkdirSync(parent);
	const manifest = {
		name: "@sharpninja/mcpserver-cline-v2-plugin",
		version: "1.118.0",
		type: "module",
		main: "dist/index.js",
		exports: {
			".": { import: "./dist/index.js" },
			"./host": { import: "./dist/host.js" },
		},
	};
	const files: Record<string, string> = {
		"package.json": JSON.stringify(manifest),
		"dist/index.js": 'throw new Error("legacy");',
		"dist/host.js": `// ${pluginComment}\nglobalThis.qbTrustImports++;
 export function createGovernedMcpServerHost(config,sdk){ globalThis.qbTrustFactories++;
 return {requiredTools:[sdk.createTool({name:"fixture",description:"Fixture",inputSchema:{type:"object"},execute:async()=>config})],hooks:{},readVerificationPolicy:async()=>({}),getRequiredModelContext:async()=>({guidance:"Fixture",tools:[]})}; }`,
		"CORE-MANIFEST.yaml": "files: {}",
		"memory-descriptor.json": "{}",
		"guidance/governed.md": "Fixture",
		"lib/repl-invoke.ps1": "# Fixture",
	};
	const bytes = Buffer.concat([
		...Object.entries(files).flatMap(([path, text]) => {
			const content = Buffer.from(text);
			const block = Buffer.alloc(512);
			new Header({
				path: `package/${path}`,
				type: "File",
				size: content.length,
				mode: 0o600,
			}).encode(block);
			return [
				block,
				content,
				Buffer.alloc((512 - (content.length % 512)) % 512),
			];
		}),
		Buffer.alloc(1024),
	]);
	const artifactPath = join(root, "reviewed.tgz");
	writeFileSync(artifactPath, bytes);
	const binding = {
		agentName: "ClineQb",
		pluginName: manifest.name,
		pluginVersion: manifest.version,
		artifactSha256: createHash("sha256").update(bytes).digest("hex"),
	};
	signedMarker(root, binding);
	const fetcher = vi.fn<typeof fetch>(async (url) =>
		Response.json({ nonce: new URL(String(url)).searchParams.get("nonce") }),
	);
	const options = {
		workspacePath: root,
		artifactPath,
		binding,
		parentDirectory: parent,
		fetch: fetcher,
	};
	return { root, parent, binding, options, fetcher };
}

it.each([
	"workspace",
	"signature",
	"artifact-binding",
	"missing-marker",
])("rejects %s before network or plugin import", async (kind) => {
	const f = fixture();
	const marker = join(f.root, "AGENTS-README-FIRST.yaml");
	if (kind === "workspace")
		signedMarker(f.root, f.binding, { workspacePath: join(f.root, "other") });
	if (kind === "signature")
		writeFileSync(
			marker,
			readFileSync(marker, "utf8").replace("synthetic-test-key", "changed"),
		);
	if (kind === "artifact-binding")
		signedMarker(f.root, { ...f.binding, artifactSha256: "b".repeat(64) });
	if (kind === "missing-marker") rmSync(marker);
	await expect(bootstrapGovernedPlugin(f.options)).rejects.toThrow(
		/^Governed plugin startup requires authenticated workspace trust and the exact reviewed artifact\.$/,
	);
	expect(f.fetcher).not.toHaveBeenCalled();
	expect(state.qbTrustImports).toBe(0);
	expect(readdirSync(f.parent)).toEqual([]);
});
it("rejects tampered archive before contacting the marker server", async () => {
	const f = fixture();
	writeFileSync(f.options.artifactPath, "tampered");
	await expect(bootstrapGovernedPlugin(f.options)).rejects.toThrow(
		/authenticated workspace trust/,
	);
	expect(f.fetcher).not.toHaveBeenCalled();
	expect(state.qbTrustImports).toBe(0);
});
it.each([
	"nonce",
	"marker-race",
])("rejects %s during authentication before import", async (kind) => {
	const f = fixture();
	f.fetcher.mockImplementation(async (url) => {
		if (kind === "marker-race")
			signedMarker(f.root, f.binding, { activation: "changed during health" });
		return Response.json({
			nonce:
				kind === "nonce"
					? "wrong"
					: new URL(String(url)).searchParams.get("nonce"),
		});
	});
	await expect(bootstrapGovernedPlugin(f.options)).rejects.toThrow(
		/authenticated workspace trust/,
	);
	expect(state.qbTrustImports).toBe(0);
	expect(readdirSync(f.parent)).toEqual([]);
});
it("imports captured verified archive bytes even if the source path changes during health", async () => {
	const f = fixture();
	f.fetcher.mockImplementation(async (url) => {
		writeFileSync(f.options.artifactPath, "changed path contents");
		return Response.json({
			nonce: new URL(String(url)).searchParams.get("nonce"),
		});
	});
	const loaded = await bootstrapGovernedPlugin(f.options);
	expect(state.qbTrustImports).toBe(1);
	expect(loaded.contract.artifactSha256.toLowerCase()).toBe(
		f.binding.artifactSha256,
	);
	expect(JSON.stringify(loaded)).not.toContain("synthetic-test-key");
});
it("reauthenticates each construction and prevents host binding overrides", async () => {
	const f = fixture();
	const loaded = await bootstrapGovernedPlugin(f.options);
	const replacementFetch = vi.fn();
	const host = await loaded.createHost({
		workspacePath: "/wrong",
		agentName: "other",
		pluginRoot: "/wrong",
		fetch: replacementFetch,
		requiredAgentPlugin: { artifactSha256: "wrong" },
	});
	const config = (await host.requiredTools[0]!.execute(
		{},
		{} as never,
	)) as Record<string, unknown>;
	expect(config.workspacePath).toBe(f.root);
	expect(config.agentName).toBe("ClineQb");
	expect(config.pluginRoot).toBe(loaded.installed.root);
	expect(config.fetch).toBe(f.fetcher);
	expect(config.requiredAgentPlugin).toMatchObject({
		artifactSha256: f.binding.artifactSha256.toUpperCase(),
	});
	expect(replacementFetch).not.toHaveBeenCalled();
	expect(f.fetcher).toHaveBeenCalledTimes(2);
	signedMarker(f.root, f.binding, { activation: "new contract" });
	await expect(loaded.createHost({})).rejects.toThrow(
		/authenticated workspace trust/,
	);
	expect(state.qbTrustFactories).toBe(1);
});
it("rechecks installed bytes after reauthentication and refuses cached-code bypass", async () => {
	const f = fixture();
	const loaded = await bootstrapGovernedPlugin(f.options);
	writeFileSync(join(loaded.installed.root, "dist/host.js"), "tampered");
	await expect(loaded.createHost({})).rejects.toThrow(
		/authenticated workspace trust/,
	);
	expect(state.qbTrustFactories).toBe(0);
});

it.each([
	undefined,
	"",
	"wrong",
	"A".repeat(64),
	null,
])("refuses missing or malformed build identity %s before trust I/O", async (value) => {
	const f = fixture();
	vi.stubGlobal("__CLINE_QB_GOVERNANCE_BUILD_DIGEST__", value);
	await expect(bootstrapGovernedPlugin(f.options)).rejects.toThrow(
		/authenticated workspace trust/,
	);
	expect(f.fetcher).not.toHaveBeenCalled();
	expect(state.qbTrustImports).toBe(0);
});
it("shares only enforcement identity across authenticated workspace bindings", async () => {
	const a = fixture();
	const b = fixture();
	const first = await bootstrapGovernedPlugin(a.options);
	const second = await bootstrapGovernedPlugin(b.options);
	expect(first.workspacePath).not.toBe(second.workspacePath);
	expect(first.peerIdentity).toEqual(second.peerIdentity);
	expect(first.peerIdentity).toEqual({
		applicationId: "cline-qb",
		policyDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
	});
	expect(first.peerIdentity.policyDigest).not.toBe(
		first.contract.contractDigest.toLowerCase(),
	);
	expect(Object.isFrozen(first.peerIdentity)).toBe(true);
	// Each host still closes over its own authenticated workspace; no global policy replaces it.
	for (const [loaded, root] of [
		[first, a.root],
		[second, b.root],
	] as const) {
		const host = await loaded.createHost({});
		const config = (await host.requiredTools[0]!.execute(
			{},
			{} as never,
		)) as Record<string, unknown>;
		expect(config.workspacePath).toBe(root);
	}
});
it("changes hub identity when enforcement build or reviewed plugin bytes change", async () => {
	const original = fixture();
	const changed = fixture("different reviewed artifact");
	const first = await bootstrapGovernedPlugin(original.options);
	const second = await bootstrapGovernedPlugin(changed.options);
	expect(first.peerIdentity).not.toEqual(second.peerIdentity);
	vi.stubGlobal("__CLINE_QB_GOVERNANCE_BUILD_DIGEST__", "b".repeat(64));
	const third = await bootstrapGovernedPlugin(original.options);
	expect(third.peerIdentity).not.toEqual(first.peerIdentity);
});
it("captures build identity before asynchronous trust callbacks", async () => {
	const a = fixture();
	const b = fixture();
	const expected = (await bootstrapGovernedPlugin(a.options)).peerIdentity;
	b.fetcher.mockImplementation(async (url) => {
		vi.stubGlobal("__CLINE_QB_GOVERNANCE_BUILD_DIGEST__", "b".repeat(64));
		return Response.json({
			nonce: new URL(String(url)).searchParams.get("nonce"),
		});
	});
	expect((await bootstrapGovernedPlugin(b.options)).peerIdentity).toEqual(
		expected,
	);
});

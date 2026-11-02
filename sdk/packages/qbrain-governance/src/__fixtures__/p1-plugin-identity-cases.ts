// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { Header } from "tar";
import type {
	IdentityFault,
	PluginIdentityInput,
	PluginIdentityScenario,
} from "./p1-plugin-identity-contract";

/**
 * Input-only synthetic archives, never approved product pins or live markers.
 * The package name/version follow the observed real manifest; its legacy-name
 * metadata is deliberately present and grants no authorization alias.
 * @remarks
 * Change log:
 * - 2026-11-02 | FR-QB-001, FR-QB-002; TR-QB-PLUGIN-001, TR-QB-TRUST-001;
 *   AC-QB-BLOCKS-EXECUTION-WHEN-REQUIRED-PLUGIN-IS-UNUSABLE,
 *   AC-QB-FAILS-CLOSED-ON-WORKSPACE-TRUST-FAILURE | Add exact identity and mismatch
 *   vectors before correcting the stale host name, without accepting an artifact.
 */
const currentName = "@qbrainai/qbrain-ai-cline-v2-plugin";
const legacyName = "@sharpninja/mcpserver-cline-v2-plugin";
const version = "1.121.0";
const hash = (bytes: Uint8Array) =>
	createHash("sha256").update(bytes).digest("hex");

function archive(manifest: PluginIdentityInput["manifestReply"]): Buffer {
	const entries = {
		"package.json": JSON.stringify({
			...manifest,
			type: "module",
			main: "dist/index.js",
			exports: {
				".": { import: "./dist/index.js" },
				"./host": { import: "./dist/host.js" },
			},
		}),
		"dist/index.js": `globalThis[Symbol.for("qbrain.test.plugin-identity-observer")]?.("ordinary.execute");
      throw new Error('Optional plugin entry must not execute');`,
		"dist/host.js": `globalThis[Symbol.for("qbrain.test.plugin-identity-observer")]?.("plugin.import");
      export function createGovernedMcpServerHost(config, sdk) {
      return { requiredTools: [sdk.createTool({ name: "identity_fixture", description: "Synthetic identity fixture",
        inputSchema: { type: "object" }, execute: async () => {
          globalThis[Symbol.for("qbrain.test.plugin-identity-observer")]?.("ordinary.execute");
          return { fixture: true };
        } })], hooks: {},
        readVerificationPolicy: async () => ({}),
        getRequiredModelContext: async () => ({ guidance: "Synthetic identity fixture", tools: [] }) };
    }`,
		"CORE-MANIFEST.yaml": "files: {}",
		"memory-descriptor.json": "{}",
		"guidance/governed.md": "Synthetic identity fixture",
		"lib/repl-invoke.ps1":
			"# Synthetic identity fixture; not a runnable production REPL",
	};
	return Buffer.concat([
		...Object.entries(entries).flatMap(([path, content]) => {
			const bytes = Buffer.from(content);
			const header = Buffer.alloc(512);
			new Header({
				path: "package/" + path,
				type: "File",
				size: bytes.length,
				mode: 0o600,
			}).encode(header);
			return [header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512)];
		}),
		Buffer.alloc(1024),
	]);
}

function input(): PluginIdentityInput {
	const manifestReply = {
		name: currentName,
		version,
		qbrainAiLegacyName: legacyName,
	};
	const archiveBytes = archive(manifestReply);
	const hostPin = {
		agentName: "ClineQb",
		pluginName: currentName,
		pluginVersion: version,
		artifactSha256: hash(archiveBytes),
	};
	return {
		hostPin,
		signedBinding: { ...hostPin },
		archiveBytes,
		manifestReply,
	};
}

const start = ["host.identity"];
const artifact = [...start, "artifact.verify"];
const signed = [...artifact, "marker.authenticate"];
const manifest = [...signed, "manifest.read"];
const complete = [...manifest, "plugin.install", "plugin.import"];
const cases: PluginIdentityScenario[] = [];

function add(
	id: string,
	change: (value: PluginIdentityInput) => void,
	operations: string[],
	controls: IdentityFault[],
	allowed = false,
): void {
	const value = input();
	change(value);
	cases.push({
		id,
		input: value,
		controls,
		expected: {
			outcome: allowed ? "ready" : "blocked",
			operations,
			acceptedBinding: allowed
				? {
						...value.hostPin,
						artifactSha256: value.hostPin.artifactSha256.toUpperCase(),
					}
				: null,
			imports: allowed ? 1 : 0,
			ordinaryExecutions: 0,
			aliasFallbacks: 0,
			diagnostic: allowed
				? null
				: "Governed plugin startup requires authenticated workspace trust and the exact reviewed artifact.",
		},
	});
}

add(
	"current-name-exact-three-authorities",
	() => {},
	complete,
	["import-before-validation"],
	true,
);
add(
	"digest-hex-case-is-not-a-package-alias",
	(value) => {
		value.hostPin.artifactSha256 = value.hostPin.artifactSha256.toUpperCase();
	},
	complete,
	[],
	true,
);
add(
	"legacy-name-even-if-all-authorities-agree",
	(value) => {
		value.manifestReply.name = legacyName;
		value.manifestReply.qbrainAiLegacyName = currentName;
		value.archiveBytes = archive(value.manifestReply);
		value.hostPin.pluginName = legacyName;
		value.hostPin.artifactSha256 = hash(value.archiveBytes);
		value.signedBinding = { ...value.hostPin };
	},
	start,
	["accept-legacy-host"],
);
for (const name of [
	"@qbrainai/qbrain-ai-cline-v2-plugin-other",
	currentName.toUpperCase(),
	" " + currentName,
])
	add(
		"host-refuses-nonexact-name:" + name,
		(value) => {
			value.hostPin.pluginName = name;
		},
		start,
		[],
	);
add(
	"host-refuses-foreign-agent",
	(value) => {
		value.hostPin.agentName = "Cline";
	},
	start,
	[],
);
add(
	"marker-refuses-legacy-name",
	(value) => {
		value.signedBinding.pluginName = legacyName;
	},
	signed,
	["ignore-signed-name"],
);
add(
	"marker-refuses-different-version",
	(value) => {
		value.signedBinding.pluginVersion = "1.120.0";
	},
	signed,
	["ignore-signed-version"],
);
add(
	"marker-refuses-different-digest",
	(value) => {
		value.signedBinding.artifactSha256 = "b".repeat(64);
	},
	signed,
	["ignore-signed-digest"],
);
add(
	"marker-refuses-foreign-agent",
	(value) => {
		value.signedBinding.agentName = "Cline";
	},
	signed,
	[],
);
add(
	"archive-refuses-different-reviewed-digest",
	(value) => {
		value.hostPin.artifactSha256 = "b".repeat(64);
	},
	artifact,
	["ignore-archive-digest"],
);
add(
	"manifest-legacy-metadata-does-not-alias-old-name",
	(value) => {
		value.manifestReply.name = legacyName;
		value.manifestReply.qbrainAiLegacyName = currentName;
		value.archiveBytes = archive(value.manifestReply);
		value.hostPin.artifactSha256 = hash(value.archiveBytes);
		value.signedBinding = { ...value.hostPin };
	},
	manifest,
	["use-legacy-manifest-alias", "ignore-manifest-name"],
);
add(
	"manifest-refuses-different-version",
	(value) => {
		value.manifestReply.version = "1.120.0";
		value.archiveBytes = archive(value.manifestReply);
		value.hostPin.artifactSha256 = hash(value.archiveBytes);
		value.signedBinding = { ...value.hostPin };
	},
	manifest,
	["ignore-manifest-version"],
);

export const pluginIdentityScenarios: readonly PluginIdentityScenario[] = cases;

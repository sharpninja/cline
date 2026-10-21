// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"
import { Glob, TOML } from "bun"

const extensionRoot = path.resolve(import.meta.dir, "../..")
const repositoryRoot = path.resolve(extensionRoot, "../..")
type Scripts = Record<string, string>

// TEST-QB-011/055: verification must consume prepared sources, not regenerate
// or reformat them after the verification fingerprint has been captured.
function commandsFor(scripts: Scripts, name: string, seen = new Set<string>()): string[] {
	if (seen.has(name) || !scripts[name]) return []
	seen.add(name)
	const command = scripts[name]
	const nested = [...command.matchAll(/\bbun\s+run\s+([\w:-]+)/g)].map((match) => match[1])
	return [
		...commandsFor(scripts, `pre${name}`, seen),
		command,
		...nested.flatMap((child) => commandsFor(scripts, child, seen)),
		...commandsFor(scripts, `post${name}`, seen),
	]
}

function generationCommands(commands: string[]): string[] {
	return commands.filter((command) => /build-proto|\bprotos\b|--write|\bformat\s+-w\b/.test(command))
}

// Independently pinned TEST-QB-011/055 commands. Upstream package scripts stay
// intact; the derivative's verification path consumes already-generated output.
const typeCommands = [
	"node node_modules/typescript/bin/tsc --noEmit",
	"node node_modules/typescript/bin/tsc --project tsconfig.vscode-compat.json --noEmit",
	"node node_modules/typescript/bin/tsc --noEmit",
]
const webviewCommands = ["node node_modules/typescript/bin/tsc -b", "node node_modules/vite/bin/vite.js build"]
const commandFixtures: Record<string, string[]> = {
	"check-types": typeCommands,
	"build:webview": webviewCommands,
	"build:production": [...webviewCommands, "bun esbuild.mjs --production"],
	package: [
		...typeCommands,
		"node node_modules/@biomejs/biome/bin/biome lint --config-path ./biome.jsonc --no-errors-on-unmatched --files-ignore-unknown=true --diagnostic-level=error",
		"pwsh scripts/proto-lint.ps1",
		...webviewCommands,
		"bun esbuild.mjs --production",
	],
	"ci:build": [...webviewCommands, "bun esbuild.mjs", "node scripts/build-tests.js"],
	"test:e2e": [
		...webviewCommands,
		"bun esbuild.mjs --production",
		"node scripts/qbrain/prepare-e2e.mjs",
		"node node_modules/@playwright/test/cli.js test",
	],
	prepare: ["node scripts/build-proto.mjs"],
}

function ownedCommandsFor(name: string): string[] {
	if (process.env.QB_VERIFICATION_CONTRACT_MODE === "mock") return [...commandFixtures[name]]
	const result = spawnSync(
		"pwsh",
		[
			"-NoProfile",
			"-NonInteractive",
			"-File",
			path.join(repositoryRoot, "qbrain/build/Invoke-VscodeBuild.ps1"),
			"-Task",
			name,
			"-ReceiptDirectory",
			path.join(repositoryRoot, "unused-plan-only-receipt"),
			"-PlanOnly",
		],
		{ cwd: repositoryRoot, encoding: "utf8", shell: false },
	)
	if (result.error) throw result.error
	if (result.status !== 0) throw new Error(`Owned command graph failed (${result.status}): ${result.stderr}`)
	const steps = JSON.parse(result.stdout) as Array<{ runtime: string; entry: string; arguments: string[] }>
	return steps.map((step) => [step.runtime, step.entry, ...step.arguments].join(" "))
}

function assertVerificationCommands(name: string, commands: string[]): void {
	expect(commands).toEqual(commandFixtures[name])
	expect(generationCommands(commands)).toEqual([])
}

describe("verification script contracts (TEST-QB-011/055)", () => {
	it("detects nested generation and implicit lifecycle writers in a stub script graph", () => {
		const scripts = {
			check: "bun run types",
			types: "tsc --noEmit",
			pretypes: "bun run protos",
			protos: "node scripts/build-proto.mjs",
			postprotos: "biome format src --write",
		}
		expect(generationCommands(commandsFor(scripts, "check"))).toEqual([
			"bun run protos",
			"node scripts/build-proto.mjs",
			"biome format src --write",
		])
		expect(generationCommands(commandsFor({ check: "tsc --noEmit" }, "check"))).toEqual([])
		for (const [name, commands] of Object.entries(commandFixtures)) {
			if (name === "prepare") continue
			assertVerificationCommands(name, [...commands])
			expect(() => assertVerificationCommands(name, [...commands, "node scripts/build-proto.mjs"])).toThrow()
			expect(() => assertVerificationCommands(name, commands.slice(1))).toThrow()
			expect(() => assertVerificationCommands(name, [...commands, "biome format src --write"])).toThrow()
		}
	})

	it.each([
		"check-types",
		"build:webview",
		"build:production",
		"package",
		"ci:build",
		"test:e2e",
	])("keeps owned %s verification free of implicit source writers", (name) => {
		assertVerificationCommands(name, ownedCommandsFor(name))
	})

	it("keeps proto generation explicit and free of implicit formatter writes", () => {
		expect(ownedCommandsFor("prepare")).toEqual(["node scripts/build-proto.mjs"])
	})

	it("selects Bun's shell without replacing Node in every workspace package", () => {
		const manifest = JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8")) as { workspaces: string[] }
		const directories = new Set([repositoryRoot, path.join(repositoryRoot, "sdk")])
		for (const workspace of manifest.workspaces) {
			for (const file of new Glob(`${workspace}/package.json`).scanSync({ cwd: repositoryRoot })) {
				directories.add(path.dirname(path.join(repositoryRoot, file)))
			}
		}
		for (const directory of directories) {
			const config = TOML.parse(readFileSync(path.join(directory, "bunfig.toml"), "utf8")) as {
				run?: { shell?: string; bun?: boolean }
			}
			expect(config.run?.shell).toBe("bun")
			expect(config.run?.bun).toBe(false)
		}
	})
})

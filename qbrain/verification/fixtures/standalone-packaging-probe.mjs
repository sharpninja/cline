// SPDX-License-Identifier: Apache-2.0
// Native Node test fixture. Expected subprocess behavior is pinned to B0 and
// the approved Bun-only, ignore-scripts command policy, not production output.
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import vm from "node:vm"

const [mode, sourcePath] = process.argv.slice(2)
const targets = [
	["win32", "x64", "win-x64"],
	["darwin", "x64", "darwin-x64"],
	["darwin", "arm64", "darwin-arm64"],
	["linux", "x64", "linux-x64"],
	["linux", "arm64", "linux-aarch64"],
]
const cases = [
	{ name: "universal" },
	{ name: "verbose", verbose: true },
	{ name: "single-host", single: true },
	{ name: "single-host-failure", single: true, failAt: 0 },
	{ name: "single-host-absent", single: true, absent: true },
	{ name: "module-absent", absent: true },
	{ name: "blocked-native-module", blocked: true },
	{ name: "install-failure", installFailure: true },
	...targets.map((_, failAt) => ({ name: `prebuild-failure-${failAt}`, failAt })),
]
const install = { program: "bun", args: ["install", "--frozen-lockfile", "--ignore-scripts"], cwd: "dist-standalone", stdio: "inherit" }
function expected(caseInfo) {
	const calls = [structuredClone(install)]
	if (!caseInfo.installFailure && !caseInfo.single && !caseInfo.absent && !caseInfo.blocked) {
		for (const [index, [platform, arch, directory]] of targets.entries()) {
			calls.push({ program: "/fixture/node", args: ["/fixture/prebuild-install/bin.js", `--platform=${platform}`, `--arch=${arch}`, "--target=22.15.0", ...(caseInfo.verbose ? ["--verbose"] : [])], cwd: `dist-standalone/binaries/${directory}/node_modules/better-sqlite3`, stdio: "inherit" })
			if (caseInfo.failAt === index) break
		}
	}
	if (caseInfo.single && !caseInfo.absent && !caseInfo.installFailure) calls.push({ program: "/fixture/node", args: ["/fixture/prebuild-install/bin.js", "--platform=linux", "--arch=x64", "--target=22.15.0", ...(caseInfo.verbose ? ["--verbose"] : [])], cwd: "dist-standalone/node_modules/better-sqlite3", stdio: "inherit" })
	const failed = Boolean(caseInfo.installFailure || caseInfo.blocked || caseInfo.failAt !== undefined)
	return { calls, exitCode: failed ? 1 : 0, archived: !failed, shellCalls: 0 }
}
function validate(observation, caseInfo) {
	assert.deepStrictEqual(observation, expected(caseInfo), caseInfo.name)
}
// Independently supplied responses cross the same observation boundary as the
// native implementation. Wrong responses must be rejected by the same validator.
function scriptedMock(caseInfo) {
	const observation = { calls: [structuredClone(install)], exitCode: 0, archived: true, shellCalls: 0 }
	if (caseInfo.installFailure || caseInfo.blocked) return { ...observation, exitCode: 1, archived: false }
	if (caseInfo.absent) return observation
	if (caseInfo.single) {
		observation.calls.push({ program: "/fixture/node", args: ["/fixture/prebuild-install/bin.js", "--platform=linux", "--arch=x64", "--target=22.15.0", ...(caseInfo.verbose ? ["--verbose"] : [])], cwd: "dist-standalone/node_modules/better-sqlite3", stdio: "inherit" })
		if (caseInfo.failAt !== undefined) { observation.exitCode = 1; observation.archived = false }
		return observation
	}
	const responses = [
		["--platform=win32", "--arch=x64", "win-x64"],
		["--platform=darwin", "--arch=x64", "darwin-x64"],
		["--platform=darwin", "--arch=arm64", "darwin-arm64"],
		["--platform=linux", "--arch=x64", "linux-x64"],
		["--platform=linux", "--arch=arm64", "linux-aarch64"],
	]
	responses.slice(0, caseInfo.failAt === undefined ? 5 : caseInfo.failAt + 1).forEach(([platform, arch, directory]) => {
		observation.calls.push({ program: "/fixture/node", args: ["/fixture/prebuild-install/bin.js", platform, arch, "--target=22.15.0", ...(caseInfo.verbose ? ["--verbose"] : [])], cwd: `dist-standalone/binaries/${directory}/node_modules/better-sqlite3`, stdio: "inherit" })
	})
	if (caseInfo.failAt !== undefined) { observation.exitCode = 1; observation.archived = false }
	return observation
}
async function observeNative(source, caseInfo) {
	const observation = { calls: [], exitCode: 0, archived: false, shellCalls: 0 }
	let prebuildIndex = 0
	const callbacks = new Map()
	const fakeFs = {
		existsSync: () => !caseInfo.absent,
		mkdirSync: () => {}, renameSync: () => {},
		readFileSync: () => "*.map\n",
		createWriteStream: () => ({ on: (event, callback) => callbacks.set(event, callback) }),
	}
	const archive = {
		on: () => archive, pipe: () => {}, glob: () => {}, directory: () => {},
		pointer: () => 0,
		finalize: async () => { observation.archived = true; callbacks.get("close")?.() },
	}
	const child = {
		execSync: () => { observation.shellCalls++; throw new Error("Shell invocation forbidden") },
		execFileSync: (program, args, options) => {
			observation.calls.push({ program, args: Array.from(args), cwd: options.cwd, stdio: options.stdio })
			if (program === "bun" && caseInfo.installFailure) throw new Error("Fixture install failure")
			if (program !== "bun" && prebuildIndex++ === caseInfo.failAt) throw new Error("Fixture prebuild failure")
		},
	}
	const dependencies = {
		archiver: { default: () => archive },
		child_process: child,
		fs: { default: fakeFs },
		"fs/promises": { cp: async () => {} },
		glob: { glob: async () => caseInfo.blocked ? ["unapproved/build/Release/native.node"] : ["better-sqlite3/build/Release/better_sqlite3.node"] },
		minimatch: { default: () => false },
		os: { default: { platform: () => "linux", arch: () => "x64" } },
		path: { default: path.posix },
		module: { createRequire: () => ({ resolve: (specifier) => { assert.equal(specifier, "prebuild-install/bin.js"); return "/fixture/prebuild-install/bin.js" } }) },
		"../file-utils.mjs": { rmrf: async () => {} },
	}
	const context = vm.createContext({
		console: { log() {}, error() {}, warn() {} },
		process: { execPath: "/fixture/node", env: {}, argv: ["node", "packager", ...(caseInfo.single ? ["-s"] : []), ...(caseInfo.verbose ? ["--verbose"] : [])], cwd: () => "/fixture/extension", exit: (code) => { const error = new Error("Fixture exit"); error.exitCode = code; throw error } },
	})
	const program = new vm.SourceTextModule(source, { context, initializeImportMeta: (meta) => { meta.url = "file:///fixture/scripts/qbrain/package-standalone.mjs" } })
	await program.link((specifier) => {
		const exports = dependencies[specifier]
		assert.ok(exports, `Unexpected dependency ${specifier}`)
		return new vm.SyntheticModule(Object.keys(exports), function () { for (const [key, value] of Object.entries(exports)) this.setExport(key, value) }, { context })
	})
	try { await program.evaluate() } catch (error) { observation.exitCode = error.exitCode ?? 1 }
	// Convert cross-realm arrays to host-native observations before comparison.
	return JSON.parse(JSON.stringify(observation))
}
let checks = 0
let negativeControls = 0
const failures = []
const results = []
const source = mode === "implementation" ? fs.readFileSync(sourcePath, "utf8") : undefined
for (const caseInfo of cases) {
	try {
		const observation = mode === "implementation" ? await observeNative(source, caseInfo) : scriptedMock(caseInfo)
		validate(observation, caseInfo)
		checks++
		if (mode === "mock") {
			for (const mutation of ["manager", "lifecycle", "lock", "directory", "stdio", "exit", "archive", "shell", "extra"]) {
				const bad = structuredClone(observation)
				if (mutation === "manager") bad.calls[0].program = "npm"
				if (mutation === "lifecycle") bad.calls[0].args = bad.calls[0].args.filter((value) => value !== "--ignore-scripts")
				if (mutation === "lock") bad.calls[0].args = bad.calls[0].args.filter((value) => value !== "--frozen-lockfile")
				if (mutation === "directory") bad.calls[0].cwd = "outside"
				if (mutation === "stdio") bad.calls[0].stdio = "pipe"
				if (mutation === "exit") bad.exitCode = 1 - bad.exitCode
				if (mutation === "archive") bad.archived = !bad.archived
				if (mutation === "shell") bad.shellCalls++
				if (mutation === "extra") bad.calls.push(structuredClone(install))
				assert.throws(() => validate(bad, caseInfo), assert.AssertionError)
				checks++; negativeControls++
			}
			if (observation.calls.length > 1) {
				for (const mutation of ["runtime", "installer", "platform", "architecture", "abi", "omit", "order"]) {
					const bad = structuredClone(observation)
					if (mutation === "runtime") bad.calls[1].program = "bun"
					if (mutation === "installer") bad.calls[1].args[0] = "unresolved-cli"
					if (mutation === "platform") bad.calls[1].args[1] = "--platform=wrong"
					if (mutation === "architecture") bad.calls[1].args[2] = "--arch=wrong"
					if (mutation === "abi") bad.calls[1].args[3] = "--target=wrong"
					if (mutation === "omit") bad.calls.pop()
					if (mutation === "order") bad.calls.reverse()
					assert.throws(() => validate(bad, caseInfo), assert.AssertionError)
					checks++; negativeControls++
				}
			}
		}
		results.push({ name: caseInfo.name, passed: true })
	} catch (error) { failures.push({ name: caseInfo.name, message: error.message }); results.push({ name: caseInfo.name, passed: false }) }
}
process.stdout.write(JSON.stringify({ mode, cases: cases.length, checks, negativeControls, failed: failures.length, failures, results, skipped: 0, scope: "Native module subprocess/failure contract under synthetic dependencies; no live archive or downloads." }) + "\n")
process.exitCode = failures.length ? 1 : 0

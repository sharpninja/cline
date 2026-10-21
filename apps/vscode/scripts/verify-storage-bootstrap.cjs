// SPDX-License-Identifier: Apache-2.0
/* Runtime check for the built VS Code and standalone entrypoints (AC-QB-053).
 * Stop at the first external VS Code API import: the private policy must already
 * be installed before storage-bearing services can initialize. Full activation
 * and installed-webview acceptance are separate checks.
 */
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { spawnSync } = require("node:child_process")
const Module = require("node:module")

if (process.argv[2] === "--child") {
	const upstream = path.join(os.homedir(), ".cline")
	const unsafe = process.argv[4] === "--unsafe"
	let forbiddenIo = 0
	for (const name of ["readFileSync", "writeFileSync", "mkdirSync", "rmSync", "unlinkSync"]) {
		const original = fs[name]
		fs[name] = function (value, ...args) {
			if (typeof value === "string" && (value === upstream || value.startsWith(upstream + path.sep))) {
				forbiddenIo++
				throw new Error("Unexpected upstream storage I/O: " + name)
			}
			return original.call(this, value, ...args)
		}
	}
	const originalLoad = Module._load
	let reachedHostApi = false
	Module._load = function (id, ...args) {
		if (id === "vscode") {
			reachedHostApi = true
			const namespace = globalThis[Symbol.for("@cline/shared/storage-namespace/v1")]
			assert.ok(namespace, "private storage policy missing before VS Code API import")
			assert.equal(namespace.resolvePath("data", { homeDir: os.homedir() }), path.join(os.homedir(), ".cline-qb", "data"))
			assert.throws(() => namespace.validatePath(path.join(upstream, "settings.json")), /upstream Cline/)
			throw new Error("QB_PROBE_HOST_BOUNDARY")
		}
		return originalLoad.call(this, id, ...args)
	}
	try {
		require(path.resolve(process.argv[3]))
		assert.fail("entrypoint did not reach host boundary")
	} catch (error) {
		if (unsafe) assert.match(error.message, /upstream Cline/)
		else assert.equal(error.message, "QB_PROBE_HOST_BOUNDARY")
	}
	assert.equal(reachedHostApi, !unsafe)
	assert.equal(forbiddenIo, 0)
	process.stdout.write(
		unsafe
			? "unsafe override rejected before host import\n"
			: "private policy installed before host import; no upstream content read or mutation\n",
	)
} else {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "qb-vscode-bootstrap-"))
	try {
		for (const bundle of process.argv.slice(2)) {
			assert.ok(fs.existsSync(bundle), "build artifact missing: " + bundle)
			for (const [seeded, unsafe] of [
				[false, false],
				[true, false],
				[false, true],
				[true, true],
			]) {
				const home = path.join(root, path.basename(path.dirname(bundle)) + "-" + seeded + "-" + unsafe)
				const upstream = path.join(home, ".cline")
				fs.mkdirSync(home, { recursive: true })
				const sentinel = path.join(upstream, "data", "globalState.json")
				if (seeded) {
					fs.mkdirSync(path.dirname(sentinel), { recursive: true })
					fs.writeFileSync(sentinel, '{"sentinel":true}')
				}
				const child = spawnSync(
					process.execPath,
					[__filename, "--child", path.resolve(bundle), unsafe ? "--unsafe" : "--safe"],
					{
						env: {
							...process.env,
							HOME: home,
							USERPROFILE: home,
							XDG_CONFIG_HOME: path.join(home, ".config"),
							CLINE_DIR: upstream,
							CLINE_DATA_DIR: path.join(upstream, "data"),
							CLINE_QB_DIR: unsafe ? upstream : "",
							CLINE_QB_DATA_DIR: "",
							CLINE_QB_SESSION_DATA_DIR: "",
							CLINE_QB_PROVIDER_SETTINGS_PATH: "",
							CLINE_QB_GLOBAL_SETTINGS_PATH: "",
							CLINE_QB_MCP_SETTINGS_PATH: "",
						},
						encoding: "utf8",
						timeout: 30000,
					},
				)
				assert.equal(child.status, 0, child.stderr || child.stdout || String(child.error))
				assert.equal(fs.existsSync(upstream), seeded)
				if (seeded) assert.equal(fs.readFileSync(sentinel, "utf8"), '{"sentinel":true}')
				console.log(
					"PASS",
					bundle,
					seeded ? "seeded" : "absent",
					unsafe ? "rejected unsafe override before host import" : "private policy",
				)
			}
		}
	} finally {
		fs.rmSync(root, { recursive: true, force: true })
	}
}

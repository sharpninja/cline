// SPDX-License-Identifier: Apache-2.0
/* AC-QB-053: execute the real activate function through storage initialization.
 * UI/services are replaced at the host seam; private bootstrap and file stores
 * are real. Full VS Code webview/installed-host execution remains a separate gate.
 */
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { spawnSync } = require("node:child_process")
const esbuild = require("esbuild")
const ts = require("typescript")

if (process.argv[2] === "--child") {
	const home = os.homedir()
	let nativeReads = 0
	globalThis.__qbMigrationCalls = 0
	const context = {
		subscriptions: [],
		extensionUri: { fsPath: path.join(home, "install") },
		extension: { id: "sharpninja.cline-qb" },
	}
	for (const field of ["globalState", "workspaceState", "secrets", "globalStorageUri"]) {
		Object.defineProperty(context, field, {
			get() {
				nativeReads++
				throw new Error("upstream native storage access: " + field)
			},
		})
	}
	const extension = require(process.argv[3])
	extension
		.activate(context)
		.then(
			() => assert.fail("expected test service boundary"),
			(error) => {
				assert.equal(error.message, "QB_STORAGE_READY")
				assert.equal(nativeReads, 0)
				assert.equal(globalThis.__qbMigrationCalls, 0)
				const data = path.join(home, ".cline-qb", "data")
				assert.equal(globalThis.__qbHostStorage, data)
				assert.equal(globalThis.__qbStorage.dataDir, data)
				globalThis.__qbStorage.globalStateBackingStore.setBatch({ privateFixture: true })
				assert.deepEqual(JSON.parse(fs.readFileSync(path.join(data, "globalState.json"), "utf8")), {
					privateFixture: true,
				})
				console.log("PASS activation: private stores and host path, zero native storage/migration calls")
			},
		)
		.catch((error) => {
			console.error(error)
			process.exitCode = 1
		})
} else {
	const app = path.resolve(__dirname, "..")
	const entry = path.join(app, "src", "extension.ts")
	const text = fs.readFileSync(process.argv[2] || entry, "utf8")
	const ast = ts.createSourceFile(entry, text, ts.ScriptTarget.Latest, true)
	const imports = new Map()
	for (const node of ast.statements) {
		if (!ts.isImportDeclaration(node)) continue
		const names = []
		const clause = node.importClause
		if (clause?.name) names.push("default")
		const bindings = clause?.namedBindings
		if (bindings && ts.isNamedImports(bindings)) {
			for (const item of bindings.elements) names.push((item.propertyName || item.name).text)
		}
		imports.set(node.moduleSpecifier.text, names)
	}
	const kept = new Set([
		"./hosts/storage-bootstrap",
		"@cline/shared",
		"@/shared/storage/storage-context",
		"@/shared/services/Logger",
	])
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "qb-vscode-activate-"))
	const bundle = path.join(root, "activate.cjs")
	esbuild
		.build({
			entryPoints: [entry],
			outfile: bundle,
			bundle: true,
			platform: "node",
			format: "cjs",
			target: "node22",
			tsconfig: path.join(app, "tsconfig.json"),
			logLevel: "silent",
			define: { "process.env.IS_DEV": "false" },
			plugins: [
				{
					name: "activation-host-seam",
					setup(build) {
						build.onLoad({ filter: /extension\.ts$/ }, (args) =>
							args.path === entry ? { contents: text, loader: "ts" } : undefined,
						)
						build.onResolve({ filter: /.*/ }, (args) => {
							if (args.importer !== entry || kept.has(args.path) || args.path.startsWith("node:")) return
							return { path: args.path, namespace: "activation-host-seam" }
						})
						build.onLoad({ filter: /.*/, namespace: "activation-host-seam" }, (args) => {
							let content
							if (args.path === "vscode") content = "export const workspace = {workspaceFolders: []};"
							else if (args.path === "@/hosts/host-provider")
								content =
									"export const HostProvider = { initialize(...args) { globalThis.__qbHostStorage = args[8]; } };"
							else if (args.path === "./common")
								content =
									"export async function initialize(storage) { globalThis.__qbStorage=storage; throw new Error('QB_STORAGE_READY'); } export function tearDown() {}"
							else if (args.path === "./hosts/vscode/hostbridge/env/debugLog")
								content = "export function registerClineOutputChannel() { return {appendLine(){}}; }"
							else
								content = (imports.get(args.path) || [])
									.map((name) => {
										const value = /migration/i.test(args.path)
											? "async function(){globalThis.__qbMigrationCalls++;}"
											: "undefined"
										return name === "default"
											? "export default " + value + ";"
											: "export const " + name + " = " + value + ";"
									})
									.join("\n")
							return { contents: content, loader: "js" }
						})
					},
				},
			],
		})
		.then(() => {
			for (const seeded of [false, true]) {
				const home = path.join(root, "home-" + seeded)
				fs.mkdirSync(home)
				const upstream = path.join(home, ".cline")
				if (seeded) {
					fs.mkdirSync(upstream)
					fs.writeFileSync(path.join(upstream, "sentinel"), "unchanged")
				}
				const child = spawnSync(process.execPath, [__filename, "--child", bundle], {
					env: {
						...process.env,
						HOME: home,
						USERPROFILE: home,
						XDG_CONFIG_HOME: path.join(home, ".config"),
						CLINE_DIR: upstream,
						CLINE_DATA_DIR: path.join(upstream, "data"),
						CLINE_QB_DIR: "",
						CLINE_QB_DATA_DIR: "",
					},
					encoding: "utf8",
					timeout: 30000,
				})
				assert.equal(child.status, 0, child.stderr || child.stdout || String(child.error))
				assert.equal(fs.existsSync(upstream), seeded)
				if (seeded) assert.equal(fs.readFileSync(path.join(upstream, "sentinel"), "utf8"), "unchanged")
				console.log(child.stdout.trim(), seeded ? "(seeded)" : "(absent)")
			}
		})
		.catch((error) => {
			console.error(error)
			process.exitCode = 1
		})
		.finally(() => fs.rmSync(root, { recursive: true, force: true }))
}

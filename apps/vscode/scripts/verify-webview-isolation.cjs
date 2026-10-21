// SPDX-License-Identifier: Apache-2.0
/* AC-QB-053: actual VS Code webview persistence, with a synthetic upstream
 * extension. No operator profile, credentials, or installed extensions are used.
 * Run with node scripts/verify-webview-isolation.cjs <receipt-directory>.
 */
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const net = require("node:net")
const { spawn } = require("node:child_process")
const { chromium } = require("playwright")
const { createHash } = require("node:crypto")
const app = path.resolve(__dirname, "..")
const output = path.resolve(process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), "qb-webview-receipt-")))
const artifactPaths = [
	__filename,
	path.join(app, "package.json"),
	path.join(app, "dist/extension.js"),
	path.join(app, "webview-ui/build/assets/index.js"),
	path.join(app, "webview-ui/build/assets/index.css"),
]
const fingerprint = () =>
	artifactPaths.map((file) => ({ file, sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex") }))
const inputArtifacts = fingerprint()
fs.mkdirSync(output, { recursive: true })
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "qb-webview-isolation-"))
const extensions = path.join(fixture, "extensions")
const upstream = path.join(extensions, "saoudrizwan.claude-dev-1.0.0")
const profile = path.join(fixture, "profile")
for (const dir of [upstream, path.join(profile, "User"), path.join(fixture, "home"), path.join(fixture, "workspace")])
	fs.mkdirSync(dir, { recursive: true })
fs.writeFileSync(
	path.join(profile, "User", "settings.json"),
	JSON.stringify({
		"telemetry.telemetryLevel": "off",
		"update.mode": "none",
		"extensions.autoUpdate": false,
		"extensions.autoCheckUpdates": false,
		"workbench.startupEditor": "none",
	}),
)
fs.writeFileSync(
	path.join(upstream, "package.json"),
	JSON.stringify({
		name: "claude-dev",
		publisher: "saoudrizwan",
		version: "1.0.0",
		engines: { vscode: "^1.85.0" },
		main: "./extension.cjs",
		activationEvents: ["onStartupFinished"],
		contributes: {
			viewsContainers: { activitybar: [{ id: "claude-dev-ActivityBar", title: "Upstream fixture", icon: "icon.svg" }] },
			views: {
				"claude-dev-ActivityBar": [{ id: "claude-dev.SidebarProvider", name: "Upstream fixture", type: "webview" }],
			},
		},
	}),
)
fs.writeFileSync(
	path.join(upstream, "icon.svg"),
	'<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16"/></svg>',
)
fs.writeFileSync(
	path.join(upstream, "extension.cjs"),
	String.raw`
const vscode = require("vscode")
exports.activate = async context => {
 if (process.env.QB_PROBE_PHASE === "seed" && !context.globalState.get("qb-sentinel")) await context.globalState.update("qb-sentinel", "upstream-native")
 context.subscriptions.push(vscode.window.registerWebviewViewProvider("claude-dev.SidebarProvider", {
  resolveWebviewView(view) {
   view.webview.options = {enableScripts:true}
   view.webview.html = '<html><body>Upstream fixture<script>window.__upstreamFixtureApi=acquireVsCodeApi()</script></body></html>'
  }
 }, {webviewOptions:{retainContextWhenHidden:true}}))
 return { readNative: () => context.globalState.get("qb-sentinel") }
}
`,
)
const controller = path.join(extensions, "qb.isolation-probe-1.0.0")
fs.mkdirSync(controller)
fs.writeFileSync(
	path.join(controller, "package.json"),
	JSON.stringify({
		name: "isolation-probe",
		publisher: "qb",
		version: "1.0.0",
		engines: { vscode: "^1.85.0" },
		main: "./extension.cjs",
		activationEvents: ["onStartupFinished"],
	}),
)
const hostTests = path.join(controller, "extension.cjs")
fs.writeFileSync(
	hostTests,
	String.raw`
const fs = require("node:fs"), http = require("node:http"), vscode = require("vscode")
exports.activate = async () => {
 const upstream = vscode.extensions.getExtension("saoudrizwan.claude-dev")
 if (!upstream) throw Error("Upstream fixture missing")
 const api = await upstream.activate()
 if (process.env.QB_PROBE_PHASE !== "seed") {
  const target = vscode.extensions.getExtension("sharpninja.cline-qb")
  if (!target) throw Error("Private extension missing")
  await target.activate()
 }
 let done
 const complete = new Promise(resolve => {done=resolve})
 const server = http.createServer(async (req,res) => {
  try {
   if (req.url === "/upstream") await vscode.commands.executeCommand("claude-dev.SidebarProvider.focus")
   else if (req.url === "/private") await vscode.commands.executeCommand("cline-qb.SidebarProvider.focus")
   else if (req.url !== "/state" && req.url !== "/done") throw Error("Unknown fixture action")
   res.end(JSON.stringify({native:api.readNative()}))
   if (req.url === "/done") done()
  } catch(error) {res.statusCode=500;res.end(String(error))}
 })
 await new Promise(resolve => server.listen(0,"127.0.0.1",resolve))
 fs.writeFileSync(process.env.QB_PROBE_READY, JSON.stringify({port:server.address().port,version:vscode.version}))
 await complete
 await new Promise(resolve => server.close(resolve))
 setTimeout(()=>vscode.commands.executeCommand("workbench.action.quit"),200)
}
`,
)
function waitFile(file, timeout = 60000) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			watcher.close()
			reject(Error("Native host did not become ready"))
		}, timeout)
		const check = () => {
			if (fs.existsSync(file)) {
				clearTimeout(timer)
				watcher.close()
				resolve(JSON.parse(fs.readFileSync(file, "utf8")))
			}
		}
		const watcher = fs.watch(path.dirname(file), check)
		check()
	})
}
async function freePort() {
	const server = net.createServer()
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
	const port = server.address().port
	await new Promise((resolve) => server.close(resolve))
	return port
}
function findFrame(page, key) {
	return new Promise((resolve, reject) => {
		const watched = new Set()
		const cleanup = () => {
			clearTimeout(timer)
			page.off("frameattached", scan)
			page.off("framenavigated", scan)
		}
		const scan = () => {
			for (const frame of page.frames()) {
				if (watched.has(frame)) continue
				watched.add(frame)
				frame
					.waitForFunction((k) => Boolean(window[k]), key, { timeout: 40000 })
					.then(() => {
						cleanup()
						resolve(frame)
					})
					.catch(() => {})
			}
		}
		const timer = setTimeout(() => {
			cleanup()
			reject(Error("Webview API not found: " + key))
		}, 45000)
		page.on("frameattached", scan)
		page.on("framenavigated", scan)
		scan()
	})
}
const keys = ["cline:spendLimitRequestCooldown", "aihubmixModels"]
async function read(frame, key) {
	return frame.evaluate(
		({ keys, key }) => ({
			origin: location.origin,
			csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content ?? null,
			values: keys.map((k) => localStorage.getItem(k)),
			state: window[key].getState() ?? null,
		}),
		{ keys, key },
	)
}
async function readPublishedState(frame) {
	return frame.evaluate(
		() =>
			new Promise((resolve, reject) => {
				const id = "qb-state-probe-" + crypto.randomUUID()
				const timer = setTimeout(() => {
					window.removeEventListener("message", receive)
					reject(new Error("Native state publication timed out"))
				}, 30000)
				function receive(event) {
					const response = event.data?.grpc_response
					if (event.data?.type !== "grpc_response" || response?.request_id !== id) return
					clearTimeout(timer)
					window.removeEventListener("message", receive)
					if (response.error) return reject(new Error(response.error))
					try {
						const message = typeof response.message === "string" ? JSON.parse(response.message) : response.message
						const state = JSON.parse(message.stateJson)
						// Return only the evidence fields, never provider credentials.
						resolve({
							hasVersion: typeof state.version === "string" && state.version.length > 0,
							banners: state.banners,
							welcomeBanners: state.welcomeBanners,
							hasClineUser: Boolean(state.userInfo),
						})
					} catch (error) {
						reject(error)
					}
				}
				window.addEventListener("message", receive)
				window.__clineVsCodeApi.postMessage({
					type: "grpc_request",
					grpc_request: {
						service: "cline.StateService",
						method: "getLatestState",
						message: {},
						request_id: id,
						is_streaming: false,
					},
				})
			}),
	)
}

async function write(frame, key, owner) {
	await frame.evaluate(
		({ keys, key, owner }) => {
			for (const k of keys) localStorage.setItem(k, owner + ":" + k)
			window[key].setState({ owner })
		},
		{ keys, key, owner },
	)
}
const packageInfo = JSON.parse(fs.readFileSync(path.join(app, "package.json"), "utf8"))
fs.symlinkSync(app, path.join(extensions, packageInfo.publisher + "." + packageInfo.name + "-" + packageInfo.version), "junction")
const rounds = []
async function round(phase) {
	const port = await freePort()
	const ready = path.join(fixture, phase + "-ready.json")
	const args = [
		"--new-window",
		"--wait",
		"--no-sandbox",
		"--disable-gpu",
		"--disable-workspace-trust",
		"--skip-welcome",
		"--skip-release-notes",
		"--user-data-dir",
		profile,
		"--extensions-dir",
		extensions,
		"--remote-debugging-port=" + port,
		path.join(fixture, "workspace"),
	]
	if (phase === "seed") args.push("--disable-extension", "sharpninja.cline-qb")
	const child = spawn(process.env.QB_CODE_EXECUTABLE || "/usr/share/code/code", args, {
		detached: process.platform !== "win32",
		env: {
			...process.env,
			HOME: path.join(fixture, "home"),
			USERPROFILE: path.join(fixture, "home"),
			XDG_CONFIG_HOME: path.join(fixture, "home", ".config"),
			CLINE_QB_DIR: path.join(fixture, "home", ".cline-qb"),
			QB_PROBE_PHASE: phase,
			QB_PROBE_READY: ready,
		},
		stdio: ["ignore", "pipe", "pipe"],
	})
	const exit = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })))
	let stdout = "",
		stderr = "",
		browser,
		control
	child.stdout.on("data", (x) => (stdout += x))
	child.stderr.on("data", (x) => (stderr += x))
	try {
		const endpoint = await waitFile(ready)
		control = async (action) => {
			const res = await fetch("http://127.0.0.1:" + endpoint.port + "/" + action)
			assert.equal(res.status, 200, await res.clone().text())
			return res.json()
		}
		browser = await chromium.connectOverCDP("http://127.0.0.1:" + port)
		const page =
			browser
				.contexts()[0]
				.pages()
				.find((p) => p.url().includes("workbench")) || browser.contexts()[0].pages()[0]
		assert.ok(page, "VS Code workbench missing")
		await control("upstream")
		const upstreamFrame = await findFrame(page, "__upstreamFixtureApi")
		if (phase === "seed") {
			await write(upstreamFrame, "__upstreamFixtureApi", "upstream")
			const state = await read(upstreamFrame, "__upstreamFixtureApi")
			assert.deepEqual(
				state.values,
				keys.map((k) => "upstream:" + k),
			)
			assert.deepEqual(state.state, { owner: "upstream" })
			rounds.push({ phase, hostVersion: endpoint.version, upstream: state })
		} else {
			const before = await read(upstreamFrame, "__upstreamFixtureApi")
			assert.deepEqual(
				before.values,
				keys.map((k) => "upstream:" + k),
			)
			assert.deepEqual(before.state, { owner: "upstream" })
			await control("private")
			const privateFrame = await findFrame(page, "__clineVsCodeApi")
			const own = await read(privateFrame, "__clineVsCodeApi")
			const publishedState = await readPublishedState(privateFrame)
			assert.equal(publishedState.hasVersion, true)
			assert.equal(publishedState.hasClineUser, false)
			assert.deepEqual(publishedState.banners, [])
			assert.deepEqual(publishedState.welcomeBanners, [])
			assert.notEqual(own.origin, before.origin)
			assert.match(own.csp, /connect-src\s+'none'\s*;/)
			assert.doesNotMatch(own.csp, /posthog\.com|cline\.bot/)
			if (phase === "verify") {
				assert.deepEqual(own.values, [null, null])
				assert.equal(own.state, null)
				await write(privateFrame, "__clineVsCodeApi", "private")
			} else {
				assert.deepEqual(
					own.values,
					keys.map((k) => "private:" + k),
				)
				assert.deepEqual(own.state, { owner: "private" })
			}
			await control("upstream")
			const after = await read(upstreamFrame, "__upstreamFixtureApi")
			assert.deepEqual(after, before)
			assert.equal((await control("state")).native, "upstream-native")
			rounds.push({
				phase,
				hostVersion: endpoint.version,
				upstream: after,
				private: await read(privateFrame, "__clineVsCodeApi"),
				publishedState,
			})
		}
		// Allow webview setState IPC and storage flush to reach the extension host
		// before requesting orderly test-host shutdown.
		await new Promise((resolve) => setTimeout(resolve, 500))
		await control("done")
		const result = await Promise.race([
			exit,
			new Promise((_, reject) => setTimeout(() => reject(Error("VS Code did not exit")), 30000)),
		])
		assert.equal(result.code, 0)
	} finally {
		if (control) await control("done").catch(() => {})
		if (browser) await browser.close().catch(() => {})
		if (child.exitCode === null) {
			try {
				process.platform === "win32" ? child.kill() : process.kill(-child.pid, "SIGTERM")
			} catch {}
		}
		fs.writeFileSync(path.join(output, phase + "-stdout.txt"), stdout)
		fs.writeFileSync(path.join(output, phase + "-stderr.txt"), stderr)
	}
}
const startedUtc = new Date().toISOString()
;(async () => {
	await round("seed")
	await round("verify")
	await round("restart")
	assert.deepEqual(fingerprint(), inputArtifacts, "Runtime artifact changed during probe")
	fs.writeFileSync(
		path.join(output, "verification.json"),
		JSON.stringify({ pass: true, startedUtc, endedUtc: new Date().toISOString(), fixture, inputArtifacts, rounds }, null, 2),
	)
	console.log("WEBVIEW_ISOLATION_PASS: seeded upstream, private startup, independent writes, restart persistence")
})().catch((error) => {
	fs.writeFileSync(
		path.join(output, "verification.json"),
		JSON.stringify(
			{
				pass: false,
				startedUtc,
				endedUtc: new Date().toISOString(),
				fixture,
				inputArtifacts,
				rounds,
				error: String(error.stack || error),
			},
			null,
			2,
		),
	)
	console.error(error)
	process.exitCode = 1
})

// SPDX-License-Identifier: Apache-2.0
// B0 downloader behavior, plus the approved no-child-shell contract.
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import vm from "node:vm"
import { EventEmitter } from "node:events"
import { promisify } from "node:util"

const [mode, sourcePath] = process.argv.slice(2)
const output = "dist-standalone/ripgrep-binaries"
const targets = [
	["darwin-x64", "x86_64-apple-darwin", "tar.gz", "rg"],
	["darwin-arm64", "aarch64-apple-darwin", "tar.gz", "rg"],
	["linux-x64", "x86_64-unknown-linux-musl", "tar.gz", "rg"],
	["linux-aarch64", "aarch64-unknown-linux-gnu", "tar.gz", "rg"],
	["win-x64", "x86_64-pc-windows-msvc", "zip", "rg.exe"],
]
const archive = (index) => `ripgrep-14.1.1-${targets[index][1]}.${targets[index][2]}`
const url = (index) => `https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/${archive(index)}`
const binary = (index) => `${output}/${targets[index][0]}/${targets[index][3]}`
const zipCall = { program: "unzip", args: ["-o", "-q", `${output}/${archive(4)}`, "-d", `${output}/win-x64`] }
const cases = [
	{ name: "all-five" }, { name: "redirect-301", redirect: 301 }, { name: "redirect-302", redirect: 302 },
	...targets.map((_, index) => ({ name: `http-failure-${index}`, failure: "http", index })),
	{ name: "request-error", failure: "request", index: 0 },
	{ name: "file-error", failure: "file", index: 1 },
	{ name: "tar-error", failure: "tar", index: 2 },
	{ name: "zip-error", failure: "zip", index: 4 },
	...targets.map((_, index) => ({ name: `missing-binary-${index}`, failure: "missing", index })),
	{ name: "chmod-error", failure: "chmod", index: 3 },
	{ name: "cleanup-error", failure: "cleanup", index: 4 },
]
function expected(c) {
	const downloads = targets.flatMap((_, i) => [url(i), ...(c.redirect && i === 0 ? ["https://fixture.invalid/redirected"] : [])])
	const preExtract = ["http", "request", "file"].includes(c.failure)
	const extracted = targets.map((_, i) => i).filter((i) => !(preExtract && c.index === i))
	const valid = targets.map((_, i) => i).filter((i) => !(c.failure && c.index === i))
	const chmod = targets.slice(0, 4).map((_, i) => i).filter((i) => !(c.index === i && c.failure !== "chmod" && c.failure !== "cleanup"))
	const cleanup = targets.map((_, i) => i).filter((i) => !(c.index === i && c.failure !== "cleanup"))
	return {
		downloads,
		tar: extracted.filter((i) => i < 4).map((i) => ({ input: `${output}/${archive(i)}`, cwd: `${output}/${targets[i][0]}`, strip: 1 })),
		zip: extracted.includes(4) ? [zipCall] : [],
		chmod: chmod.map((i) => ({ file: binary(i), mode: 0o755 })),
		cleanup: cleanup.map((i) => `${output}/${archive(i)}`),
		ready: targets.map((_, i) => i).filter((i) => valid.includes(i) || (c.failure === "cleanup" && c.index === i)).map(binary),
		exitCode: c.failure ? 1 : 0,
		summary: `${c.failure ? 4 : 5}/5 platforms successful`,
		shellCalls: 0,
	}
}
// Scripted fixture responses are supplied through the observation boundary,
// separately from expected(). Mutation controls attack each observed field.
function scriptedMock(c) {
	const o = { downloads: [], tar: [], zip: [], chmod: [], cleanup: [], ready: [], exitCode: 0, summary: "5/5 platforms successful", shellCalls: 0 }
	for (let i = 0; i < 5; i++) {
		o.downloads.push(url(i))
		if (c.redirect && i === 0) o.downloads.push("https://fixture.invalid/redirected")
		const fail = c.index === i ? c.failure : undefined
		if (["http", "request", "file"].includes(fail)) continue
		if (i === 4) o.zip.push(structuredClone(zipCall))
		else o.tar.push({ input: `${output}/${archive(i)}`, cwd: `${output}/${targets[i][0]}`, strip: 1 })
		if (["tar", "zip", "missing"].includes(fail)) continue
		if (i < 4) o.chmod.push({ file: binary(i), mode: 493 })
		if (fail === "chmod") continue
		o.ready.push(binary(i))
		o.cleanup.push(`${output}/${archive(i)}`)
	}
	if (c.failure) { o.exitCode = 1; o.summary = "4/5 platforms successful" }
	return o
}
function validate(o, c) { assert.deepStrictEqual(o, expected(c), c.name) }
async function observe(source, c) {
	const o = { downloads: [], tar: [], zip: [], chmod: [], cleanup: [], ready: [], exitCode: 0, summary: "", shellCalls: 0 }
	let index = -1
	let zipFlattened = false
	const streams = new Map()
	let complete
	const done = new Promise((resolve) => { complete = resolve })
	const fakeFs = {
		mkdirSync() {},
		createWriteStream(file) { const stream = new EventEmitter(); stream.close = () => {}; streams.set(file, stream); return stream },
		createReadStream: (file) => file,
		unlink(file, callback) { callback() },
		unlinkSync(file) { o.cleanup.push(file); if (c.failure === "cleanup" && c.index === index) throw new Error("cleanup failure") },
		existsSync(file) { if (file.endsWith("rg.exe")) return zipFlattened && !(c.failure === "missing" && c.index === index); if (file.endsWith("rg")) return !(c.failure === "missing" && c.index === index); return false },
		chmodSync(file, permissions) { o.chmod.push({ file, mode: permissions }); if (c.failure === "chmod" && c.index === index) throw new Error("chmod failure") },
		readdirSync: (directory) => directory.endsWith("win-x64") ? ["ripgrep-fixture"] : ["rg.exe"],
		renameSync() { zipFlattened = true }, rmdirSync() {},
	}
	const fakeHttps = { get(address, callback) {
		o.downloads.push(address)
		if (address !== "https://fixture.invalid/redirected") index++
		const request = new EventEmitter()
		queueMicrotask(() => {
			if (c.index === index && c.failure === "request") { request.emit("error", new Error("request failure")); return }
			if (c.index === index && c.failure === "file") { streams.get(`${output}/${archive(index)}`).emit("error", new Error("file failure")); return }
			if (c.redirect && index === 0 && address !== "https://fixture.invalid/redirected") { callback({ statusCode: c.redirect, headers: { location: "https://fixture.invalid/redirected" } }); return }
			if (c.index === index && c.failure === "http") { callback({ statusCode: 404, statusMessage: "Not Found" }); return }
			callback({ statusCode: 200, pipe(stream) { queueMicrotask(() => stream.emit("finish")) } })
		})
		return request
	} }
	const dependencies = {
		child_process: {
			exec() { o.shellCalls++; throw new Error("Shell forbidden") },
			execFile(program, args, callback) { o.zip.push({ program, args: Array.from(args) }); callback(c.failure === "zip" ? new Error("zip failure") : null, "", "") },
		},
		fs: { default: fakeFs }, https: { default: fakeHttps }, path: { default: path.posix },
		"stream/promises": { pipeline: async (input, _gunzip, options) => { o.tar.push({ input, ...options }); if (c.failure === "tar" && c.index === index) throw new Error("tar failure") } },
		tar: { extract: (options) => ({ cwd: options.cwd, strip: options.strip }) },
		util: { promisify }, zlib: { createGunzip: () => ({}) },
	}
	const context = vm.createContext({ console: {
		log(value) {
			if (typeof value !== "string") return
			if (value.startsWith("  ✓ Binary ready: ")) o.ready.push(value.slice("  ✓ Binary ready: ".length))
			if (value.includes("/5 platforms successful")) o.summary = value.slice(2)
			if (value.includes("All ripgrep binaries downloaded successfully!")) complete()
		}, error() {},
	}, process: { exit(code) { o.exitCode = code; complete() } } })
	const program = new vm.SourceTextModule(source, { context })
	await program.link((specifier) => {
		const exports = dependencies[specifier]
		assert.ok(exports, `Unexpected dependency: ${specifier}`)
		return new vm.SyntheticModule(Object.keys(exports), function () { for (const [key, value] of Object.entries(exports)) this.setExport(key, value) }, { context })
	})
	await program.evaluate()
	let timer
	try { await Promise.race([done, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Fixture did not complete")), 5000) })]) }
	finally { clearTimeout(timer) }
	return JSON.parse(JSON.stringify(o))
}
let checks = 0, negativeControls = 0
const failures = [], results = []
const source = mode === "implementation" ? fs.readFileSync(sourcePath, "utf8") : undefined
for (const c of cases) {
	try {
		const o = mode === "implementation" ? await observe(source, c) : scriptedMock(c)
		validate(o, c); checks++
		for (const field of Object.keys(o)) {
			const bad = structuredClone(o)
			if (Array.isArray(bad[field])) bad[field].push("unexpected")
			else if (typeof bad[field] === "number") bad[field]++
			else bad[field] = "wrong"
			assert.throws(() => validate(bad, c), assert.AssertionError); checks++; negativeControls++
		}
		if (o.zip.length) {
			for (const mutate of [x => { x.zip[0].program = "sh" }, x => { x.zip[0].args = [x.zip[0].args.join(" ")] }, x => { x.zip[0].args[2] = "wrong archive" }, x => { x.zip[0].args[4] = "wrong destination" }]) {
				const bad = structuredClone(o); mutate(bad)
				assert.throws(() => validate(bad, c), assert.AssertionError); checks++; negativeControls++
			}
		}
		results.push({ name: c.name, passed: true })
	} catch (error) { failures.push({ name: c.name, message: error.message }); results.push({ name: c.name, passed: false }) }
}
process.stdout.write(JSON.stringify({ mode, cases: cases.length, checks, negativeControls, failed: failures.length, skipped: 0, failures, results, scope: "Actual native JS under synthetic dependencies; five target and failure contracts. No live download claim." }) + "\n")
process.exitCode = failures.length ? 1 : 0

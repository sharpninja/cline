// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

// TEST-QB-055: verification must be non-writing and fail closed on each check.
// The fake Buf isolates exit-code propagation from the installed Buf version.
const lintScript = path.resolve(import.meta.dir, "../../scripts/proto-lint.ps1")
const roots: string[] = []

function fixture(source = "service Example { rpc GetItem (Request) returns (Response); }\n") {
	const root = mkdtempSync(path.join(tmpdir(), "qbrain-proto-lint-"))
	roots.push(root)
	const protoDir = path.join(root, "proto with spaces", "nested")
	mkdirSync(protoDir, { recursive: true })
	const proto = path.join(protoDir, "service.proto")
	writeFileSync(proto, source)
	const buf = path.join(root, "fake buf.ps1")
	writeFileSync(
		buf,
		`$ErrorActionPreference = 'Stop'
Add-Content -LiteralPath $env:QB_TEST_BUF_LOG -Value ($args -join ' ')
if ($args[0] -eq 'lint') { exit [int]$env:QB_TEST_LINT_EXIT }
if (($args -join ' ') -eq 'format --diff --exit-code') { exit [int]$env:QB_TEST_FORMAT_EXIT }
throw 'Unexpected or potentially writing Buf command'
`,
	)
	return { root, proto, buf, log: path.join(root, "commands.txt"), source }
}

function run(f: ReturnType<typeof fixture>, lintExit = 0, formatExit = 0, script = lintScript) {
	return spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", script, "-BufPath", f.buf], {
		cwd: f.root,
		encoding: "utf8",
		timeout: 15_000,
		env: {
			...process.env,
			QB_TEST_BUF_LOG: f.log,
			QB_TEST_LINT_EXIT: String(lintExit),
			QB_TEST_FORMAT_EXIT: String(formatExit),
		},
	})
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("proto verification contract (TEST-QB-055)", () => {
	it("validates the stub's success, failure and forbidden-command behavior before using it", () => {
		const f = fixture()
		const invoke = (args: string[], code: string) =>
			spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", f.buf, ...args], {
				encoding: "utf8",
				env: { ...process.env, QB_TEST_BUF_LOG: f.log, QB_TEST_LINT_EXIT: code, QB_TEST_FORMAT_EXIT: code },
			})
		expect(invoke(["lint"], "0").status).toBe(0)
		expect(invoke(["lint"], "7").status).toBe(7)
		expect(invoke(["format", "--diff", "--exit-code"], "9").status).toBe(9)
		expect(invoke(["format", "-w"], "0").status).not.toBe(0)
	})

	it("runs both Buf checks without mutating proto files", () => {
		const f = fixture()
		const result = run(f)
		expect(result.error).toBeUndefined()
		expect(result.status).toBe(0)
		expect(readFileSync(f.log, "utf8").trim().split(/\r?\n/)).toEqual(["lint", "format --diff --exit-code"])
		expect(readFileSync(f.proto, "utf8")).toBe(f.source)
	})

	it.each([
		[7, 0],
		[0, 9],
	])("rejects failed lint=%i or format=%i even when names are valid", (lintExit, formatExit) => {
		const f = fixture()
		const result = run(f, lintExit, formatExit)
		expect(result.error).toBeUndefined()
		expect(result.status).not.toBe(0)
		expect(result.stdout + result.stderr).toContain("Buf")
		expect(readFileSync(f.proto, "utf8")).toBe(f.source)
	})

	it("rejects repeated capitals in a recursively discovered RPC name and identifies the file", () => {
		const f = fixture("service Example { rpc GetHTTPInfo (Request) returns (Response); }\n")
		const result = run(f)
		expect(result.status).not.toBe(0)
		expect(result.stdout + result.stderr).toContain("service.proto")
		expect(readFileSync(f.proto, "utf8")).toBe(f.source)
	})

	it("accepts consecutive lowercase characters in normal camel-case RPC names", () => {
		const f = fixture("service Example { rpc getWorkspaceState (Request) returns (Response); }\n")
		expect(run(f).status).toBe(0)
	})

	it("fails when Buf cannot be launched", () => {
		const f = fixture()
		rmSync(f.buf)
		const result = run(f)
		expect(result.status).not.toBe(0)
		expect(result.stdout + result.stderr).toContain("fake buf.ps1")
	})
})

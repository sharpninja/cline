// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { runInNewContext } from "node:vm"

type Invocation = { executable: string; args: string[]; options: Record<string, unknown> }

// TEST-QB-055: execute the actual build script with filesystem/compiler stubs.
// This observes process arguments without launching a compiler or a shell.
function exercise(source: string) {
	const shellCalls: string[] = []
	const processCalls: Invocation[] = []
	const writes: Array<{ filename: string; content: string }> = []
	const fakeRequire = Object.assign(
		(id: string): unknown => {
			switch (id) {
				case "child_process":
					return {
						execSync: (command: string) => shellCalls.push(command),
						execFileSync: (executable: string, args: string[], options: Record<string, unknown>) =>
							processCalls.push({ executable, args, options }),
					}
				case "fs":
					return {
						rmSync: () => {},
						readdirSync: () => [],
						readFileSync: () => '{ "exclude": ["existing-exclusion"] }',
						writeFileSync: (filename: string, content: string) => writes.push({ filename, content }),
					}
				case "path":
					return path
				case "json5":
					return { parse: JSON.parse }
				case "esbuild":
					return { context: async () => ({ rebuild: async () => {}, dispose: async () => {} }) }
				default:
					throw new Error(`Unexpected dependency: ${id}`)
			}
		},
		{ resolve: (id: string) => `/fixture packages/${id}` },
	)
	runInNewContext(source, {
		require: fakeRequire,
		__dirname: "/fixture workspace/scripts",
		process: {
			argv: [],
			execPath: "/runtime with spaces/node",
			exit: () => {
				throw new Error("Unexpected exit")
			},
		},
		console,
	})
	return { shellCalls, processCalls, writes }
}

describe("integration compiler process contract (TEST-QB-055)", () => {
	it("checks the process spy using a shell-free stub before exercising the build script", () => {
		const result = exercise(
			'require("child_process").execFileSync(process.execPath, ["compiler with spaces", "-p", "config with spaces"], { encoding: "utf8" })',
		)
		expect(result.shellCalls).toEqual([])
		expect(result.processCalls).toEqual([
			{
				executable: "/runtime with spaces/node",
				args: ["compiler with spaces", "-p", "config with spaces"],
				options: { encoding: "utf8" },
			},
		])
	})

	it("launches resolved TypeScript through native Node with unquoted argv and no shell", () => {
		const source = readFileSync(path.resolve(import.meta.dir, "../../scripts/build-tests.js"), "utf8")
		const result = exercise(source)
		expect(result.shellCalls).toEqual([])
		expect(result.processCalls).toEqual([
			{
				executable: "/runtime with spaces/node",
				args: [
					"/fixture packages/typescript/bin/tsc",
					"-p",
					"/fixture workspace/tsconfig.test.generated.json",
					"--outDir",
					"out",
				],
				options: { encoding: "utf-8" },
			},
		])
		expect(JSON.parse(result.writes[0].content).exclude).toEqual(["existing-exclusion"])
	})
})

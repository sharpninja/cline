#!/usr/bin/env bun

import path from "node:path"
import { parseConcurrency, runPool } from "./run-bun-unit-tests"
/**
 * Runner for the historical SDK-adapter + model-catalog `bun test` suites.
 * This is a distinct runner from the broader `test:vitest` selection.
 *
 * Why a script instead of a bare `bun test <globs>`:
 *
 *  1. Curated include set. These suites are an explicit list (see
 *     INCLUDE_PATTERNS),
 *     not the whole tree, so the node-side unit and @vscode/test-cli suites are
 *     not pulled in. `bun test`'s positional args don't expand `**` the way we
 *     need, so we resolve the globs ourselves with bun's `Glob`.
 *
 *  2. One process per file. `bun test` runs all files in a single process by
 *     default, so `mock.module(...)` registrations leak between files — suites
 *     mocking the same specifier with different shapes (e.g.
 *     `@/core/storage/StateManager`, `@cline/core`) clobber each other.
 *     Bun's --parallel reuses workers and their module mocks. The shared
 *     bounded pool starts a separate Bun process for every file instead.
 *
 * Usage:
 *   bun scripts/run-bun-tests.ts            # run the curated set, isolated
 *   bun scripts/run-bun-tests.ts --list     # print the resolved file list only
 */
import { Glob } from "bun"

// Preserve this runner's existing case selection independently of Vitest.
const INCLUDE_PATTERNS = [
	"src/sdk/**/*.test.ts",
	"src/shared/vsCodeSelectorUtils.test.ts",
	"src/core/storage/remote-config/**/*.test.ts",
	"src/shared/model-catalog/provider-helpers.test.ts",
	"src/core/controller/models/__tests__/providerCatalogHandlers.test.ts",
	"src/core/controller/models/__tests__/providerSwitchNormalization.test.ts",
	"src/core/controller/models/__tests__/resolveModelInfo.test.ts",
	"src/core/controller/models/__tests__/providerCatalogSmoke.test.ts",
	"src/core/controller/models/__tests__/refreshClineRecommendedModels.test.ts",
]

const projectRoot = path.resolve(import.meta.dir, "..")

async function resolveFiles(): Promise<string[]> {
	const seen = new Set<string>()
	for (const pattern of INCLUDE_PATTERNS) {
		const glob = new Glob(pattern)
		for await (const match of glob.scan({ cwd: projectRoot, onlyFiles: true })) {
			seen.add(match)
		}
	}
	return [...seen].sort()
}

async function main(): Promise<void> {
	const files = await resolveFiles()
	if (files.length === 0) {
		console.error("run-bun-tests: no test files matched the include patterns")
		process.exit(1)
	}

	const passthrough = process.argv.slice(2)
	if (passthrough.includes("--list")) {
		console.log(files.join("\n"))
		return
	}

	const testArgs: string[] = []
	for (let index = 0; index < passthrough.length; index++) {
		if (passthrough[index] === "-c" || passthrough[index] === "--concurrency") index++
		else testArgs.push(passthrough[index])
	}
	const results = await runPool(files, parseConcurrency(passthrough), testArgs)
	const pass = results.reduce((sum, result) => sum + result.pass, 0)
	const fail = results.reduce((sum, result) => sum + result.fail, 0)
	const errors = results.filter((result) => result.code !== 0 && result.fail === 0).length
	console.log(`Files: ${results.length}   Pass: ${pass}   Fail: ${fail}   Errors: ${errors}`)
	if (results.some((result) => result.code !== 0 || result.fail > 0)) process.exit(1)
}

void main()

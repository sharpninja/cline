// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, it } from "bun:test"
import { expect, vi } from "vitest"
import { createTool } from "@cline/shared"
import { resolveExistingFilePath } from "@cline/shared/storage"

// TEST-QB-055: both preserved extension runners need faithful environment
// fixtures. Only synthetic keys are touched; no operator settings are used.
const existingKey = "QB_TEST_COMPAT_EXISTING"
const absentKey = "QB_TEST_COMPAT_ABSENT"

afterEach(() => {
	vi.unstubAllEnvs?.()
	vi.unstubAllGlobals?.()
	vi.useRealTimers()
	delete process.env[existingKey]
	delete process.env[absentKey]
})

describe("Bun Vitest global and original-module compatibility (TEST-QB-055)", () => {
	it("preserves real timer APIs omitted by an explicit toFake selection", async () => {
		const originalImmediate = setImmediate
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		expect(setImmediate).toBe(originalImmediate)
		await new Promise<void>((resolve) => setImmediate(resolve))
	})

	it("advances timers created after asynchronous callback work within the requested interval", async () => {
		vi.useFakeTimers()
		const events: string[] = []
		setTimeout(async () => {
			events.push("first")
			await Promise.resolve()
			setTimeout(() => events.push("second"), 10)
		}, 10)
		await vi.advanceTimersByTimeAsync(19)
		expect(events).toEqual(["first"])
		await vi.advanceTimersByTimeAsync(1)
		expect(events).toEqual(["first", "second"])
	})

	it("matches exactly one call with deep and asymmetric arguments", () => {
		const callback = vi.fn()
		callback({ key: "value", extra: true }, [1, 2])
		expect(callback).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ key: "value" }), [1, 2])
		expect(callback).not.toHaveBeenCalledExactlyOnceWith({ key: "wrong" }, [1, 2])
	})

	it("rejects zero calls, repeated calls and mismatched argument counts", () => {
		const callback = vi.fn()
		expect(callback).not.toHaveBeenCalledExactlyOnceWith("value")
		callback("value")
		expect(callback).not.toHaveBeenCalledExactlyOnceWith("value", "extra")
		callback("value")
		expect(callback).not.toHaveBeenCalledExactlyOnceWith("value")
		expect(() => expect(callback).toHaveBeenCalledExactlyOnceWith("value")).toThrow()
	})

	it("keeps shared SDK re-exports callable when the core package is mocked", () => {
		expect(typeof createTool).toBe("function")
		expect(typeof resolveExistingFilePath).toBe("function")
	})

	it("restores a global property descriptor after repeated stubs", () => {
		const name = "QB_TEST_COMPAT_GLOBAL"
		const original = { configurable: true, enumerable: false, get: () => "original" }
		Object.defineProperty(globalThis, name, original)
		try {
			vi.stubGlobal(name, "first")
			vi.stubGlobal(name, "second")
			expect(Reflect.get(globalThis, name)).toBe("second")
			vi.unstubAllGlobals()
			expect(Object.getOwnPropertyDescriptor(globalThis, name)).toEqual(original)
		} finally {
			Reflect.deleteProperty(globalThis, name)
		}
	})

	it("removes a previously absent global after cleanup", () => {
		const name = "QB_TEST_COMPAT_ABSENT_GLOBAL"
		vi.stubGlobal(name, undefined)
		expect(Object.hasOwn(globalThis, name)).toBe(true)
		vi.unstubAllGlobals()
		expect(Object.hasOwn(globalThis, name)).toBe(false)
	})

	it("supplies the actual Node namespace to a mock factory", () => {
		let original: typeof import("node:querystring") | undefined
		vi.mock("node:querystring", (importOriginal) => {
			original = importOriginal<typeof import("node:querystring")>() as unknown as typeof import("node:querystring")
			return original ?? {}
		})
		expect(original?.parse("key=value")).toEqual({ key: "value" })
	})
})

describe("Bun Vitest environment fixture compatibility (TEST-QB-055)", () => {
	it("restores the original value after repeated overrides", () => {
		process.env[existingKey] = "original"
		vi.stubEnv(existingKey, "first")
		vi.stubEnv(existingKey, "second")
		expect(process.env[existingKey]).toBe("second")
		vi.unstubAllEnvs()
		expect(process.env[existingKey]).toBe("original")
	})

	it("restores absence and distinguishes an empty original value", () => {
		delete process.env[absentKey]
		process.env[existingKey] = ""
		vi.stubEnv(absentKey, "temporary")
		vi.stubEnv(existingKey, undefined)
		expect(process.env[existingKey]).toBeUndefined()
		expect(process.env[absentKey]).toBe("temporary")
		vi.unstubAllEnvs()
		expect(process.env[absentKey]).toBeUndefined()
		expect(process.env[existingKey]).toBe("")
	})

	it("forgets restored overrides so a later fixture gets its own baseline", () => {
		process.env[existingKey] = "first baseline"
		vi.stubEnv(existingKey, "temporary")
		vi.unstubAllEnvs()
		process.env[existingKey] = "second baseline"
		vi.stubEnv(existingKey, "another temporary")
		vi.unstubAllEnvs()
		vi.unstubAllEnvs()
		expect(process.env[existingKey]).toBe("second baseline")
	})
})

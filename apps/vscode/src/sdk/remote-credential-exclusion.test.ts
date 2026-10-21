// SPDX-License-Identifier: Apache-2.0
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { StateManager } from "@/core/storage/StateManager"
import { createStorageContext } from "@/shared/storage/storage-context"
vi.mock("@/services/logging/distinctId", () => ({ initializeDistinctId: vi.fn(async () => undefined) }))
let dir: string
let state: StateManager
beforeAll(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "qb-remote-credential-"))
	await StateManager.initialize(createStorageContext({ clineDir: dir, workspacePath: dir }))
	state = StateManager.get()
})
afterAll(async () => {
	if (state) {
		await state.flushPendingState()
		await state.reInitialize()
	}
	await fs.rm(dir, { recursive: true, force: true })
})
describe("AC-QB-017/018 legacy remote credential exclusion", () => {
	for (const direct of [undefined, "synthetic-direct-key"]) {
		it("does not substitute a cached hosted-policy key, direct=" + Boolean(direct), async () => {
			state.setApiConfiguration({
				planModeApiProvider: "litellm",
				actModeApiProvider: "litellm",
				liteLlmBaseUrl: "https://proxy.example.invalid",
			})
			state.setSecret("liteLlmApiKey", direct)
			state.setSecret("remoteLiteLlmApiKey", "synthetic-legacy-remote-key")
			await state.flushPendingState()
			const config = state.getApiConfiguration()
			expect(config.liteLlmApiKey).toBe(direct)
			expect(config.remoteLiteLlmApiKey).toBeUndefined()
			expect(config.liteLlmBaseUrl).toBe("https://proxy.example.invalid")
			expect(config.actModeApiProvider).toBe("litellm")
			expect(state.getSecretKey("remoteLiteLlmApiKey")).toBe("synthetic-legacy-remote-key")
			expect(state.getSecretKey("liteLlmApiKey")).toBe(direct)
		})
	}
})

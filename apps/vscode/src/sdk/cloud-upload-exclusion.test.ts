// SPDX-License-Identifier: Apache-2.0
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { blobStorage, type BlobStoreSettings } from "@/shared/storage/ClineBlobStorage"
import { syncWorker } from "@/shared/services/worker/sync"
import { getBlobStoreSettingsFromEnv, SyncWorker } from "@/shared/services/worker/worker"
import { backfillTasks } from "@/shared/services/worker/backfill"
import { testPromptUploading } from "@/core/controller/state/testPromptUploading"
import { ClineFileStorage } from "@/shared/storage/ClineFileStorage"

const remote = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), remove: vi.fn() }))
const adapter = vi.hoisted(() => vi.fn())
vi.mock("@/shared/storage/adapters", () => ({ getStorageAdapter: adapter }))
vi.mock("@/shared/services/Logger", () => ({ Logger: { log: vi.fn(), error: vi.fn() } }))
vi.mock("@/core/storage/disk", () => ({
	GlobalFileNames: { apiConversationHistory: "api_conversation_history.json" },
	getSavedApiConversationHistory: vi.fn(),
}))
const home = fs.mkdtempSync(path.join(os.tmpdir(), "qb-upload-exclusion-"))
vi.mock("@/hosts/host-provider", () => ({ HostProvider: { get: () => ({ globalStorageFsPath: home }) } }))
const queuePath = path.join(home, "cache", "sync-queue.json")
const legacyQueue = JSON.stringify({
	items: [{ id: "old-queued-item", taskId: "legacy-task", status: "pending", data: "synthetic transcript" }],
})
function settings(adapterType = "s3"): BlobStoreSettings {
	return {
		adapterType,
		bucket: "synthetic",
		accessKeyId: "synthetic-id",
		secretAccessKey: "synthetic-secret",
		endpoint: "https://upload.example.invalid",
		accountId: "synthetic-account",
		backfillEnabled: true,
		intervalMs: 60000,
	}
}
beforeEach(() => {
	vi.clearAllMocks()
	adapter.mockReturnValue(remote)
	fs.mkdirSync(path.dirname(queuePath), { recursive: true })
	fs.writeFileSync(queuePath, legacyQueue)
})
afterEach(async () => {
	await syncWorker().dispose()
	vi.unstubAllEnvs()
})
afterAll(() => fs.rmSync(home, { recursive: true, force: true }))

describe("AC-QB-016/017 transcript and artifact upload exclusion", () => {
	for (const kind of ["s3", "r2", "azure"]) {
		it(`cannot enable ${kind} uploads through initial or refreshed settings`, () => {
			blobStorage.init(settings(kind))
			blobStorage.init({ ...settings(kind), bucket: "changed-bucket", accessKeyId: "changed-key" })
			expect(blobStorage.isReady()).toBe(false)
			expect(adapter).not.toHaveBeenCalled()
		})
	}
	it("refuses the explicit upload operation with an actionable policy error", async () => {
		blobStorage.init(settings())
		await expect(blobStorage._dangerousStore("artifact.json", "synthetic artifact")).rejects.toMatchObject({
			code: "cline_uploads_disabled",
		})
		expect(remote.write).not.toHaveBeenCalled()
	})
	it("does not contact a backend through any background storage operation", async () => {
		blobStorage.init(settings())
		expect(await blobStorage.get("transcript.json")).toBeUndefined()
		await blobStorage.store("transcript.json", "synthetic transcript")
		await blobStorage.delete("transcript.json")
		expect(adapter).not.toHaveBeenCalled()
		for (const operation of Object.values(remote)) expect(operation).not.toHaveBeenCalled()
	})
	it("legacy environment configuration cannot start sync or replay a persisted queue", async () => {
		for (const [name, value] of Object.entries({
			CLINE_STORAGE_ADAPTER: "s3",
			CLINE_STORAGE_BUCKET: "synthetic",
			CLINE_STORAGE_ACCESS_KEY_ID: "synthetic",
			CLINE_STORAGE_SECRET_ACCESS_KEY: "synthetic",
			CLINE_STORAGE_SYNC_BACKFILL_ENABLED: "true",
		}))
			vi.stubEnv(name, value)
		const sync = syncWorker()
		expect(sync.init({ ...getBlobStoreSettingsFromEnv(), userDistinctId: "synthetic-user" })).toBeNull()
		expect(sync.getSyncQueue()).toBeNull()
		sync.enqueue("new-task", "transcript.json", "synthetic new transcript")
		expect(await backfillTasks({ taskIds: ["legacy-task"] })).toBeUndefined()
		await sync.dispose()
		expect(fs.readFileSync(queuePath, "utf8")).toBe(legacyQueue)
		expect(adapter).not.toHaveBeenCalled()
	})
	it("direct worker restart leaves queued data and backend untouched", async () => {
		blobStorage.init(settings())
		const queue = { getPendingBatch: vi.fn(() => []), cleanupFailedItems: vi.fn(), enforceMaxSize: vi.fn() }
		const worker = new SyncWorker(queue as any, { ...settings(), userDistinctId: "synthetic-user" })
		try {
			worker.start()
			// A callback queued before shutdown must also leave the queue untouched.
			await (worker as any).processQueue()
			expect(worker.getStatus().isRunning).toBe(false)
		} finally {
			await worker.stop()
		}
		for (const method of Object.values(queue)) expect(method).not.toHaveBeenCalled()
		expect(remote.write).not.toHaveBeenCalled()
		expect(fs.readFileSync(queuePath, "utf8")).toBe(legacyQueue)
	})
	it("connection-test UI reports policy exclusion, not missing credentials or success", async () => {
		blobStorage.init(settings())
		const result = await testPromptUploading({} as any, {})
		expect(result.success).toBe(false)
		expect(result.error).toMatch(/uploads.*unavailable.*cline-qb/i)
		expect(remote.write).not.toHaveBeenCalled()
	})
	it("local file storage remains writable and survives a restart", async () => {
		const file = path.join(home, "local-state.json")
		const local = new ClineFileStorage(file)
		await local.setBatch({ transcript: "local synthetic data" })
		expect(new ClineFileStorage(file).get("transcript")).toBe("local synthetic data")
		expect(adapter).not.toHaveBeenCalled()
	})
})

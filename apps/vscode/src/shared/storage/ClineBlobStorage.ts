import { ClineStorage } from "./ClineStorage"
import type { BlobStoreSettings } from "./types"

export type { BlobStoreSettings } from "./types"

export const UPLOADS_DISABLED_MESSAGE = "Transcript and artifact uploads are unavailable in cline-qb. Data stays local."

/**
 * Compatibility boundary for old startup, settings and background-sync callers.
 * No configuration can construct a remote storage adapter in cline-qb.
 * Keep legacy queues untouched rather than replaying or migrating their contents.
 */
class ClineBlobStorage extends ClineStorage {
	override name = "ClineBlobStorage"

	public init(_settings?: BlobStoreSettings): void {}

	public isReady(): boolean {
		return false
	}

	public static isConfigured(_settings: BlobStoreSettings): boolean {
		return false
	}

	protected async _get(_key: string): Promise<string | undefined> {
		return undefined
	}

	protected async _store(_key: string, _value: string): Promise<void> {
		throw Object.assign(new Error(UPLOADS_DISABLED_MESSAGE), { code: "cline_uploads_disabled" })
	}

	protected async _delete(_key: string): Promise<void> {
		// Excluded remote records must not be modified either.
	}
}

export const blobStorage = new ClineBlobStorage()

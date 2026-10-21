import type { Controller } from "@/sdk/SdkController"
import { clearRemoteConfig } from "./utils"

export interface RefreshSdkRemoteConfigOptions {
	workspacePath?: string
	rootPath?: string
	isCurrent?: () => boolean
}

const publicationTails = new WeakMap<object, Promise<void>>()

async function withPublicationLock<T>(controller: object, operation: () => Promise<T>): Promise<T> {
	const previous = publicationTails.get(controller) ?? Promise.resolve()
	let release!: () => void
	const current = new Promise<void>((resolve) => {
		release = resolve
	})
	publicationTails.set(controller, current)

	await previous
	try {
		return await operation()
	} finally {
		release()
		if (publicationTails.get(controller) === current) {
			publicationTails.delete(controller)
		}
	}
}

/** Retire runtime policy without reading, materializing or deleting hosted caches. */
export async function clearSdkRemoteConfig(
	controller: Controller,
	_options: { workspacePath?: string; organizationId?: string } = {},
): Promise<void> {
	await withPublicationLock(controller, async () => {
		await clearRemoteConfig()
		controller.setRemoteConfigAvailable(false)
		await controller.setRemoteConfigCoreIntegration(undefined)
	})
}

export async function refreshSdkRemoteConfig(
	controller: Controller,
	options: RefreshSdkRemoteConfigOptions = {},
): Promise<boolean> {
	const isCurrent = options.isCurrent ?? (() => true)
	if (!isCurrent()) return false
	let cleared = false
	await withPublicationLock(controller, async () => {
		if (!isCurrent()) return
		await clearRemoteConfig()
		if (!isCurrent()) return
		controller.setRemoteConfigAvailable(false)
		await controller.setRemoteConfigCoreIntegration(undefined)
		cleared = true
	})
	if (cleared && isCurrent()) await controller.postStateToWebview()
	return cleared && isCurrent()
}

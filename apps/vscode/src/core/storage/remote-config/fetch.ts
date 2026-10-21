import type { Controller } from "@/core/controller"
import { clearSdkRemoteConfig } from "./sdk-refresh"

/** Legacy entry point: retire runtime policy without contacting Cline Cloud. */
export async function fetchRemoteConfig(controller: Controller): Promise<void> {
	await clearSdkRemoteConfig(controller)
	await controller.postStateToWebview()
}

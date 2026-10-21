import type { StringRequest } from "@/shared/proto/cline/common"
import { Empty } from "@/shared/proto/cline/common"
import { Logger } from "@/shared/services/Logger"
import type { Controller } from ".."

/**
 * Clears stale browser banner state locally; hosted banners are disabled.
 * @param controller The controller instance
 * @param request The request containing the banner ID to dismiss
 * @returns Empty response
 */
export async function dismissBanner(controller: Controller, request: StringRequest): Promise<Empty> {
	const bannerId = request.value

	if (!bannerId) {
		return {}
	}
	try {
		// Publish the empty banner state without a hosted-service call.
		await controller.postStateToWebview()
	} catch (error) {
		Logger.error("Failed to dismiss banner:", error)
	}
	return {}
}

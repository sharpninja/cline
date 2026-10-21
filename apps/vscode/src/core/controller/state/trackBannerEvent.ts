import type { Empty } from "@/shared/proto/cline/common"
import type { TrackBannerEventRequest } from "@/shared/proto/cline/state"
import type { Controller } from ".."

/** Accept stale browser messages without emitting hosted banner events. */
export async function trackBannerEvent(_controller: Controller, _request: TrackBannerEventRequest): Promise<Empty> {
	return {}
}

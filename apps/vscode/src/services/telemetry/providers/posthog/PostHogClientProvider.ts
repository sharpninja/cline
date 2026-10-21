import type { EventMessage, PostHog } from "posthog-node"
import { Logger } from "@/shared/services/Logger"

export class PostHogClientProvider {
	private static _instance: PostHogClientProvider | null = null

	public static getInstance(): PostHogClientProvider {
		if (!PostHogClientProvider._instance) {
			PostHogClientProvider._instance = new PostHogClientProvider()
		}
		return PostHogClientProvider._instance
	}

	public static getClient(): PostHog | null {
		return PostHogClientProvider.getInstance().client
	}

	private readonly client: PostHog | null

	private constructor() {
		// Product policy is unconditional; legacy keys and host mode cannot enable it.
		this.client = null
	}

	/**
	 * Filters PostHog events before they are sent.
	 * For exceptions, we only capture those from the Cline extension.
	 * this is specifically to avoid capturing errors from anything other than Cline
	 */
	static eventFilter(event: EventMessage | null) {
		if (!event || event?.event !== "$exception") {
			return event
		}
		const exceptionList = event.properties?.["$exception_list"]
		if (!exceptionList?.length) {
			return null
		}

		// Check if any exception is from Cline
		for (let i = 0; i < exceptionList.length; i++) {
			const stacktrace = exceptionList[i].stacktrace
			// Fast check: error message contains "cline"
			if (stacktrace?.value?.toLowerCase().includes("cline")) {
				return event
			}

			const frames = stacktrace?.frames
			if (frames?.length) {
				for (let j = 0; j < frames.length; j++) {
					const fileName = frames[j]?.filename
					// The extension filename will include "saoudrizwan"
					// The CLI filename will include "cline"
					if (fileName?.includes("saoudrizwan") || fileName?.includes("cline")) {
						return event
					}
				}
			}
		}

		return null
	}

	public async dispose(): Promise<void> {
		await this.client?.shutdown().catch((error) => Logger.error("Error shutting down PostHog client:", error))
	}
}

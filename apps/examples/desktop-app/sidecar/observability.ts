import { type ITelemetryService, setSdkLogger } from "@cline/core";
import type { UserContext } from "@cline/shared";
import {
	createDesktopLoggerAdapter,
	type DesktopLoggerAdapter,
} from "./logging";

const disabledTelemetry: ITelemetryService = Object.freeze({
	setDistinctId() {},
	setMetadata() {},
	updateMetadata() {},
	setCommonProperties() {},
	updateCommonProperties() {},
	isEnabled: () => false,
	capture() {},
	captureRequired() {},
	recordCounter() {},
	recordHistogram() {},
	recordGauge() {},
	async flush() {},
	async dispose() {},
});
export interface DesktopObservability {
	readonly logger: DesktopLoggerAdapter["core"];
	readonly telemetry: ITelemetryService;
	readonly telemetryUser?: UserContext;
	dispose(): Promise<void>;
}
/** Keep local diagnostics without initializing account state or exporters. */
export function createDesktopObservability(): DesktopObservability {
	const loggerAdapter = createDesktopLoggerAdapter();
	const logger = loggerAdapter.core;
	setSdkLogger(logger);
	let disposed = false;
	return {
		logger,
		telemetry: disabledTelemetry,
		async dispose() {
			if (disposed) return;
			disposed = true;
			setSdkLogger(undefined);
			loggerAdapter.dispose();
		},
	};
}

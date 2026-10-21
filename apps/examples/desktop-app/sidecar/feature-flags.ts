import {
	type BasicLogger,
	FEATURE_FLAGS,
	type FeatureFlagPayload,
	type FeatureFlagsContext,
	FeatureFlagsService,
	type ITelemetryService,
	NoOpFeatureFlagsProvider,
} from "@cline/core";
import type { FeatureFlag } from "@cline/shared";

/** Host policy: no identity, remote provider, persistent cache or override. */
class DisabledDesktopFeatureFlags extends FeatureFlagsService {
	constructor(logger?: BasicLogger) {
		super({
			provider: new NoOpFeatureFlagsProvider(),
			logger,
			context: getDesktopFeatureFlagsContext(),
		});
	}
	override setContext(_context: FeatureFlagsContext): void {}
	override hydrateCache(
		_snapshot: Parameters<FeatureFlagsService["hydrateCache"]>[0],
	): void {}
	override test(_flag: FeatureFlag, _value: boolean): void {}
	override async poll(_userId?: string | null): Promise<void> {}
	override getBooleanFlagEnabled(_flag: FeatureFlag): boolean {
		return false;
	}
	override getFlagPayload(_flag: FeatureFlag): FeatureFlagPayload {
		return false;
	}
}
let desktopFeatureFlagsService: FeatureFlagsService | undefined;
export function getDesktopFeatureFlagsContext(): FeatureFlagsContext {
	return { clientName: "cline-qb" };
}
export function getDesktopFeatureFlagsService(options?: {
	logger?: BasicLogger;
	telemetry?: ITelemetryService;
}): FeatureFlagsService {
	return (desktopFeatureFlagsService ??= new DisabledDesktopFeatureFlags(
		options?.logger,
	));
}
export async function disposeDesktopFeatureFlagsService(): Promise<void> {
	const current = desktopFeatureFlagsService;
	desktopFeatureFlagsService = undefined;
	await current?.dispose();
}
export function setDesktopFeatureFlagsAccountContext(
	_account: { id?: string; email?: string },
	_options?: { logger?: BasicLogger },
): boolean {
	return false;
}
export async function identifyDesktopFeatureFlagsAccount(
	_account: { id?: string; email?: string },
	_options?: { logger?: BasicLogger; telemetry?: ITelemetryService },
): Promise<void> {}
export type FeatureFlagsSnapshot = {
	flags: Record<string, FeatureFlagPayload>;
};
export function buildFeatureFlagsSnapshot(
	_service: FeatureFlagsService,
): FeatureFlagsSnapshot {
	return {
		flags: Object.fromEntries(FEATURE_FLAGS.map((flag) => [flag, false])),
	};
}
export async function refreshDesktopFeatureFlags(options?: {
	logger?: BasicLogger;
	telemetry?: ITelemetryService;
}): Promise<FeatureFlagsSnapshot> {
	return buildFeatureFlagsSnapshot(getDesktopFeatureFlagsService(options));
}
export function resetDesktopFeatureFlagsForTesting(): void {
	desktopFeatureFlagsService = undefined;
}
/** Compatibility API: environment configuration cannot enable hosted agents. */
export function readCloudAgentsEnvOverride(): boolean {
	return false;
}
export function isCloudAgentsAvailable(_options?: {
	logger?: BasicLogger;
	telemetry?: ITelemetryService;
}): boolean {
	return false;
}
export function isCloudAgentsEnabled(_options?: {
	logger?: BasicLogger;
	telemetry?: ITelemetryService;
}): boolean {
	return false;
}

// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ErrorProviderFactory } from "@/services/error/ErrorProviderFactory"
import { FeatureFlagsProviderFactory } from "@/services/feature-flags/FeatureFlagsProviderFactory"
import { TelemetryProviderFactory } from "@/services/telemetry/TelemetryProviderFactory"
import { PostHogClientProvider } from "@/services/telemetry/providers/posthog/PostHogClientProvider"

const fixture = vi.hoisted(() => ({ selfHosted: false, client: vi.fn(), otel: vi.fn() }))
vi.mock("@/config", () => ({ ClineEndpoint: { isSelfHosted: () => fixture.selfHosted } }))
vi.mock("@/shared/services/Logger", () => ({ Logger: { log: vi.fn(), info: vi.fn(), error: vi.fn() } }))
vi.mock("@/shared/services/config/posthog-config", () => ({
	isPostHogConfigValid: () => true,
	posthogConfig: {
		apiKey: "synthetic-key",
		errorTrackingApiKey: "synthetic-error-key",
		host: "https://collector.example.invalid",
		enableErrorAutocapture: true,
	},
}))
vi.mock("@/shared/services/config/otel-config", () => ({
	getValidOpenTelemetryConfig: () => ({
		enabled: true,
		metricsExporter: "otlp",
		otlpEndpoint: "https://collector.example.invalid",
	}),
	getValidRuntimeOpenTelemetryConfig: () => ({
		enabled: true,
		logsExporter: "otlp",
		otlpEndpoint: "https://legacy.example.invalid",
	}),
}))
vi.mock("posthog-node", () => ({
	PostHog: class {
		constructor() {
			fixture.client()
			throw new Error("Prohibited PostHog construction intercepted")
		}
	},
}))
vi.mock("@/services/telemetry/providers/opentelemetry/OpenTelemetryClientProvider", () => ({
	OpenTelemetryClientProvider: class {
		constructor() {
			fixture.otel()
			throw new Error("Prohibited OTEL construction intercepted")
		}
	},
}))
beforeEach(() => {
	vi.clearAllMocks()
	;(PostHogClientProvider as any)._instance = null
})
for (const selfHosted of [false, true])
	describe(`AC-QB-016/017 observability exclusion selfHosted=${selfHosted}`, () => {
		beforeEach(() => {
			fixture.selfHosted = selfHosted
		})
		it("ignores valid legacy telemetry settings without constructing any exporter", async () => {
			expect(TelemetryProviderFactory.getDefaultConfigs()).toEqual([{ type: "no-op" }])
			const providers = await TelemetryProviderFactory.createProviders()
			for (const provider of providers) {
				expect(provider.isEnabled()).toBe(false)
				provider.log("synthetic-event", {})
				await provider.forceFlush()
				await provider.dispose()
			}
			expect(fixture.client).not.toHaveBeenCalled()
			expect(fixture.otel).not.toHaveBeenCalled()
		})
		it("explicit error-provider settings cannot enable external reporting", async () => {
			expect(ErrorProviderFactory.getDefaultConfig().type).toBe("no-op")
			const provider = await ErrorProviderFactory.createProvider({
				type: "posthog",
				config: {
					apiKey: "synthetic",
					errorTrackingApiKey: "synthetic",
					host: "https://collector.example.invalid",
					uiHost: "https://collector.example.invalid",
				},
			})
			await provider.captureException(new Error("synthetic local error"))
			await provider.dispose()
			expect(fixture.client).not.toHaveBeenCalled()
		})
		it("explicit hosted-flag settings return only local defaults", async () => {
			expect(FeatureFlagsProviderFactory.getDefaultConfig().type).toBe("no-op")
			const provider = FeatureFlagsProviderFactory.createProvider({ type: "posthog" })
			expect(await provider.getAllFlagsAndPayloads({ flagKeys: ["synthetic-remote-flag"] })).toEqual({})
			await provider.dispose()
			expect(fixture.client).not.toHaveBeenCalled()
		})
		it("direct shared-client access and teardown never start a hosted client", async () => {
			expect(PostHogClientProvider.getClient()).toBeNull()
			await PostHogClientProvider.getInstance().dispose()
			expect(PostHogClientProvider.getClient()).toBeNull()
			expect(fixture.client).not.toHaveBeenCalled()
		})
	})

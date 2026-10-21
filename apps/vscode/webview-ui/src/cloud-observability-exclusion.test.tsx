// SPDX-License-Identifier: Apache-2.0
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CustomPostHogProvider } from "./CustomPostHogProvider"
import { useHasFeatureFlag } from "./hooks/useFeatureFlag"
const fixture = vi.hoisted(() => ({ setting: "enabled", environment: "production" }))
const client = vi.hoisted(() => ({
	init: vi.fn(),
	identify: vi.fn(),
	set_config: vi.fn(),
	has_opted_in_capturing: vi.fn(() => false),
	has_opted_out_capturing: vi.fn(() => false),
	opt_in_capturing: vi.fn(),
	opt_out_capturing: vi.fn(),
	isFeatureEnabled: vi.fn(() => true),
	onFeatureFlags: vi.fn(() => () => {}),
}))
vi.mock("posthog-js", () => ({ default: client }))
vi.mock("posthog-js/react", () => ({ PostHogProvider: ({ children }: any) => children }))
vi.mock("@shared/services/config/posthog-config", () => ({
	posthogConfig: { apiKey: "synthetic-legacy-key", host: "https://collector.example.invalid" },
}))
vi.mock("./context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		environment: fixture.environment,
		telemetrySetting: fixture.setting,
		distinctId: "synthetic-user",
		version: "synthetic",
		userInfo: { email: "synthetic@example.invalid" },
	}),
}))
function Child() {
	return <div data-testid="local-child">{String(useHasFeatureFlag("legacy-hosted-flag"))}</div>
}
beforeEach(() => vi.clearAllMocks())
afterEach(() => cleanup())
describe("AC-QB-016/017 browser hosted-service exclusion", () => {
	for (const setting of ["enabled", "disabled"])
		it(`ignores old browser flags and telemetry setting ${setting} through remount`, () => {
			fixture.setting = setting
			fixture.environment = "production"
			const first = render(
				<CustomPostHogProvider>
					<Child />
				</CustomPostHogProvider>,
			)
			expect(screen.getByTestId("local-child").textContent).toBe("false")
			first.rerender(
				<CustomPostHogProvider>
					<Child />
				</CustomPostHogProvider>,
			)
			first.unmount()
			render(
				<CustomPostHogProvider>
					<Child />
				</CustomPostHogProvider>,
			)
			expect(screen.getByTestId("local-child").textContent).toBe("false")
			for (const method of Object.values(client)) expect(method).not.toHaveBeenCalled()
		})
})

import { afterEach, describe, it } from "bun:test"
/**
 * Tests for selfHosted mode behavior across PostHog-based services.
 * When ClineEndpoint.isSelfHosted() returns true, all PostHog functionality should be disabled.
 */

import * as assert from "assert"
import * as sinon from "sinon"
import { ClineEndpoint } from "@/config"
import { ErrorProviderFactory } from "../error/ErrorProviderFactory"
import { FeatureFlagsProviderFactory } from "../feature-flags/FeatureFlagsProviderFactory"

describe("SelfHosted Mode - PostHog Disabling", () => {
	let isSelfHostedStub: sinon.SinonStub

	afterEach(() => {
		if (isSelfHostedStub) {
			isSelfHostedStub.restore()
		}
	})

	describe("FeatureFlagsProviderFactory", () => {
		it("should return no-op config when in selfHosted mode", () => {
			isSelfHostedStub = sinon.stub(ClineEndpoint, "isSelfHosted").returns(true)

			const config = FeatureFlagsProviderFactory.getDefaultConfig()

			assert.strictEqual(config.type, "no-op", "Should return no-op type in selfHosted mode")
		})

		it("returns no-op flags outside selfHosted mode too", () => {
			isSelfHostedStub = sinon.stub(ClineEndpoint, "isSelfHosted").returns(false)

			const config = FeatureFlagsProviderFactory.getDefaultConfig()

			// Product policy applies independently of the deployment mode.
			assert.strictEqual(config.type, "no-op", "Hosted flags cannot be enabled in any mode")
		})

		it("should create NoOp provider when in selfHosted mode", () => {
			isSelfHostedStub = sinon.stub(ClineEndpoint, "isSelfHosted").returns(true)

			const config = FeatureFlagsProviderFactory.getDefaultConfig()
			const provider = FeatureFlagsProviderFactory.createProvider(config)

			// NoOp provider should always be enabled (returns true for isEnabled)
			assert.strictEqual(provider.isEnabled(), true, "NoOp provider should report as enabled")
		})
	})

	describe("ErrorProviderFactory", () => {
		it("should return no-op config when in selfHosted mode", () => {
			isSelfHostedStub = sinon.stub(ClineEndpoint, "isSelfHosted").returns(true)

			const config = ErrorProviderFactory.getDefaultConfig()

			assert.strictEqual(config.type, "no-op", "Should return no-op type in selfHosted mode")
		})

		it("returns no-op errors outside selfHosted mode too", () => {
			isSelfHostedStub = sinon.stub(ClineEndpoint, "isSelfHosted").returns(false)

			const config = ErrorProviderFactory.getDefaultConfig()

			assert.strictEqual(config.type, "no-op", "No external reporting in any mode")
		})

		it("should create NoOp provider when in selfHosted mode", async () => {
			isSelfHostedStub = sinon.stub(ClineEndpoint, "isSelfHosted").returns(true)

			const config = ErrorProviderFactory.getDefaultConfig()
			const provider = await ErrorProviderFactory.createProvider(config)

			// NoOp provider should always be enabled
			assert.strictEqual(provider.isEnabled(), true, "NoOp provider should report as enabled")

			await provider.dispose()
		})
	})

	describe("Integration - selfHosted should disable all PostHog services", () => {
		it("should return no-op for all PostHog-based factories when selfHosted", () => {
			isSelfHostedStub = sinon.stub(ClineEndpoint, "isSelfHosted").returns(true)

			const featureFlagsConfig = FeatureFlagsProviderFactory.getDefaultConfig()
			const errorConfig = ErrorProviderFactory.getDefaultConfig()

			assert.strictEqual(featureFlagsConfig.type, "no-op", "FeatureFlags should be no-op in selfHosted")
			assert.strictEqual(errorConfig.type, "no-op", "Error provider should be no-op in selfHosted")
		})
	})
})

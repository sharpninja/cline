import { describe, it } from "bun:test"
import * as assert from "assert"
import sinon from "sinon"
import { installMarketplaceEntry } from "../installMarketplaceEntry"
import { MarketplaceEntry } from "@shared/proto/cline/marketplace"

describe("installMarketplaceEntry", () => {
	for (const type of ["mcp", "plugin", "skill"])
		it(`refuses cached ${type} entries before state or local installation`, async () => {
			const policy = sinon.stub()
			const reconcile = sinon.stub()
			const controller = {
				stateManager: { getRemoteConfigSettings: policy },
				mcpHub: { reconcileMcpServersFromSettingsRPC: reconcile },
			}
			await assert.rejects(
				installMarketplaceEntry(controller as never, { entry: MarketplaceEntry.create({ id: "legacy", type }) }),
				{ code: "cline_cloud_disabled" },
			)
			assert.ok(policy.notCalled)
			assert.ok(reconcile.notCalled)
		})
})

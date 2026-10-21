import { ClineCloudDisabledError } from "@cline/qbrain-governance/cloud-policy"
import type { MarketplaceEntryRequest, MarketplaceInstallResult } from "@shared/proto/cline/marketplace"
import type { Controller } from "../index"

export async function installMarketplaceEntry(
	_controller: Controller,
	_request: MarketplaceEntryRequest,
): Promise<MarketplaceInstallResult> {
	throw new ClineCloudDisabledError()
}

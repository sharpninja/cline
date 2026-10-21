import { ClineCloudDisabledError } from "@cline/qbrain-governance/cloud-policy"
import type { Controller } from "@/sdk"
import type { RemoteConfigSetting, ToggleRemoteConfigSettingRequest } from "@/shared/proto/index.cline"

export async function toggleRemoteConfigSetting(
	_controller: Controller,
	_request: ToggleRemoteConfigSettingRequest,
): Promise<RemoteConfigSetting> {
	throw new ClineCloudDisabledError()
}

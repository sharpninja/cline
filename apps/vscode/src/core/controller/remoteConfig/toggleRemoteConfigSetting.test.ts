import { RemoteConfigType, ToggleRemoteConfigSettingRequest } from "@shared/proto/cline/remote_config"
import { describe, expect, it, vi } from "vitest"
import { toggleRemoteConfigSetting } from "./toggleRemoteConfigSetting"

describe("AC-QB-017 managed setting exclusion", () => {
	for (const type of [RemoteConfigType.RULE, RemoteConfigType.WORKFLOW, RemoteConfigType.SKILL, -1]) {
		for (const enabled of [false, true]) {
			it(`refuses type ${type}, enabled ${enabled}, before mutating local settings`, async () => {
				const controller = {
					stateManager: {
						getRemoteConfigSettings: vi.fn(() => ({})),
						getGlobalStateKey: vi.fn(() => ({})),
						setGlobalState: vi.fn(),
					},
					rematerializeRemoteConfig: vi.fn().mockResolvedValue(undefined),
				}
				await expect(
					toggleRemoteConfigSetting(
						controller as never,
						ToggleRemoteConfigSettingRequest.create({ type, name: "Shared", enabled }),
					),
				).rejects.toMatchObject({ code: "cline_cloud_disabled" })
				expect(controller.stateManager.getRemoteConfigSettings).not.toHaveBeenCalled()
				expect(controller.stateManager.getGlobalStateKey).not.toHaveBeenCalled()
				expect(controller.stateManager.setGlobalState).not.toHaveBeenCalled()
				expect(controller.rematerializeRemoteConfig).not.toHaveBeenCalled()
			})
		}
	}
})

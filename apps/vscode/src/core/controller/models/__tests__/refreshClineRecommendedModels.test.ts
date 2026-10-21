import * as sdkCore from "@cline/core"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { refreshClineRecommendedModels, resetClineRecommendedModelsCacheForTests } from "../refreshClineRecommendedModels"
import { refreshClineRecommendedModelsRpc } from "../refreshClineRecommendedModelsRpc"

import { ClineEnv } from "@/config"
beforeEach(() => {
	resetClineRecommendedModelsCacheForTests()
	vi.spyOn(ClineEnv, "config").mockReturnValue({ apiBaseUrl: "https://fixture.invalid" } as ReturnType<typeof ClineEnv.config>)
})
afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
})
describe("AC-QB-016/017 Cline recommendation exclusion", () => {
	it("returns no hosted recommendations through helper and RPC without network or SDK fallback", async () => {
		const fetcher = vi.fn()
		vi.stubGlobal("fetch", fetcher)
		const sdk = vi.spyOn(sdkCore, "fetchClineRecommendedModels").mockResolvedValue({
			recommended: [{ id: "legacy", name: "Legacy", description: "", tags: [] }],
			free: [],
			clinePass: [],
		})
		for (let i = 0; i < 3; i++) {
			resetClineRecommendedModelsCacheForTests()
			expect(await refreshClineRecommendedModels()).toEqual({ recommended: [], free: [], clinePass: [] })
			expect(await refreshClineRecommendedModelsRpc({} as never, {})).toMatchObject({
				recommended: [],
				free: [],
				clinePass: [],
			})
		}
		expect(sdk).not.toHaveBeenCalled()
		expect(fetcher).not.toHaveBeenCalled()
	})
	it("does not retain caller mutations as cached hosted models", async () => {
		vi.spyOn(sdkCore, "fetchClineRecommendedModels").mockResolvedValue({ recommended: [], free: [], clinePass: [] })
		const first = await refreshClineRecommendedModels()
		first.free.push({ id: "legacy", name: "Legacy", description: "", tags: [] })
		expect(await refreshClineRecommendedModels()).toEqual({ recommended: [], free: [], clinePass: [] })
	})
})

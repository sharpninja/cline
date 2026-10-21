interface ClineRecommendedModelData {
	id: string
	name: string
	description: string
	tags: string[]
}

export interface ClineRecommendedModelsData {
	recommended: ClineRecommendedModelData[]
	free: ClineRecommendedModelData[]
	clinePass?: ClineRecommendedModelData[]
}

/** Cline-hosted catalogs are unavailable; direct-provider catalogs are independent. */
export async function refreshClineRecommendedModels(): Promise<ClineRecommendedModelsData> {
	return { recommended: [], free: [], clinePass: [] }
}

export function resetClineRecommendedModelsCacheForTests(): void {}

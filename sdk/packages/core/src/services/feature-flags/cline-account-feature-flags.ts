import type { FeatureFlag } from "@cline/shared";

/** Saved accounts and remote rollout grants cannot enable Cline services. */
export async function isClineAccountFeatureEnabled(
	_flag: FeatureFlag,
): Promise<boolean> {
	return false;
}

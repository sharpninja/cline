import {
	listLocalProviders as internalListLocalProviders,
	type ProviderSettingsManager,
} from "@cline/core";
import { isClineCloudProvider } from "./cloud-policy";

export async function listLocalProviders(
	manager: ProviderSettingsManager,
): ReturnType<typeof internalListLocalProviders> {
	return await internalListLocalProviders(manager, {
		includeProvider: (id) => !isClineCloudProvider(id),
	});
}

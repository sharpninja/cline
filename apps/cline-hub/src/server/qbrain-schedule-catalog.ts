// Registered host catalog only. No network refresh, credential lookup or provider fallback.
import { ensureCustomProvidersLoaded, Llms, type ProviderSettingsManager } from "@cline/core";
import { isClineCloudProvider, requireDirectProvider } from "@cline/qbrain-governance/cloud-policy";
import type { ScheduleCatalog } from "./qbrain-schedule-admission";

export async function readRegisteredScheduleCatalog(
  providerId: string,
  manager: ProviderSettingsManager,
): Promise<ScheduleCatalog[]> {
  requireDirectProvider(providerId);
  await ensureCustomProvidersLoaded(manager);
  const state = manager.read();
  const ids = Llms.getProviderIds().filter((id) => !isClineCloudProvider(id));
  return Promise.all(ids.map(async (id) => {
    const models = await Llms.getModelsForProvider(id, { filter: "chat" });
    return { providerId: id, enabled: Boolean(state.providers[id]?.settings), models: Object.keys(models) };
  }));
}

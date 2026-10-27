// Private app-host admission. This module performs no discovery, storage or transport.
import { isClineCloudProvider } from "@cline/qbrain-governance/cloud-policy";
export interface SchedulePair {
  providerId: string;
  modelId: string;
}
export interface ScheduleCatalog {
  providerId: string;
  enabled: boolean;
  models: readonly string[];
}
export interface ExplicitRememberedSchedulePair {
  explicit: true;
  pair: SchedulePair;
}
export class ScheduleAdmissionError extends Error {
  override name = "ScheduleAdmissionError";
}
function nonempty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
export function readExplicitSchedulePair(
  value: unknown,
  remembered?: ExplicitRememberedSchedulePair,
): SchedulePair {
  const raw = record(value);
  if (!raw) {
    if (value === undefined && remembered?.explicit === true) {
      return readExplicitSchedulePair({ modelSelection: remembered.pair });
    }
    throw new ScheduleAdmissionError("Select both provider and model explicitly in Settings.");
  }
  // Presence, including null/undefined, is authoritative. Never borrow a member.
  const structured = Object.prototype.hasOwnProperty.call(raw, "modelSelection");
  const selection = structured ? record(raw.modelSelection) : raw;
  if (!selection) {
    throw new ScheduleAdmissionError("Repair modelSelection as a complete provider/model pair.");
  }
  const providerId = nonempty(structured ? selection.providerId : selection.providerId ?? selection.provider);
  const modelId = nonempty(structured ? selection.modelId : selection.modelId ?? selection.model);
  if (!providerId || !modelId) {
    throw new ScheduleAdmissionError("Select both provider and model explicitly in Settings.");
  }
  return { providerId, modelId };
}
export function requireDirectSchedulePair(pair: SchedulePair): SchedulePair {
  if (isClineCloudProvider(pair.providerId)) {
    throw new ScheduleAdmissionError("Select a permitted direct model provider and model; hosted Cline routes are unavailable.");
  }
  return pair;
}
export async function admitSchedulePair(
  raw: unknown,
  loadCatalog: (providerId: string) => Promise<readonly ScheduleCatalog[]>,
  remembered?: ExplicitRememberedSchedulePair,
): Promise<SchedulePair> {
  const pair = requireDirectSchedulePair(readExplicitSchedulePair(raw, remembered));
  let catalogs: readonly ScheduleCatalog[];
  try {
    catalogs = await loadCatalog(pair.providerId);
  } catch (error) {
    throw new ScheduleAdmissionError(
      "Catalog unavailable. Open Settings and retry: " + (error instanceof Error ? error.message : String(error)),
    );
  }
  // Typed callbacks still cross a runtime boundary. Malformed data cannot admit by truthiness or substring.
  if (!Array.isArray(catalogs) || catalogs.some((entry: unknown) => {
    const item = record(entry);
    return !item || typeof item.providerId !== "string" || !item.providerId.trim()
      || typeof item.enabled !== "boolean" || !Array.isArray(item.models)
      || item.models.some((id: unknown) => typeof id !== "string" || !id.trim());
  })) {
    throw new ScheduleAdmissionError("Catalog response is malformed. Open Settings and retry.");
  }
  const catalog = catalogs.find((entry) => entry.providerId === pair.providerId);
  if (!catalog || !catalog.enabled || !catalog.models.includes(pair.modelId)) {
    throw new ScheduleAdmissionError("Selected provider/model is unavailable in its current enabled catalog. Open Settings.");
  }
  return pair;
}
export function inspectSchedulePair(value: unknown): string | undefined {
  try {
    const pair = readExplicitSchedulePair(value);
    if (isClineCloudProvider(pair.providerId)) {
      return "Select a direct provider and model before saving this legacy schedule.";
    }
    return undefined;
  } catch (error) {
    if (!(error instanceof ScheduleAdmissionError)) throw error;
    return error.message;
  }
}

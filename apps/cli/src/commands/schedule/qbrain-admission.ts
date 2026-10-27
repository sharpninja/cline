import { ProviderSettingsManager } from "@cline/core";
import { admitSchedulePair } from "../../../../cline-hub/src/server/qbrain-schedule-admission";
import { readRegisteredScheduleCatalog } from "../../../../cline-hub/src/server/qbrain-schedule-catalog";
import type { ScheduleAdmission } from "./types";

// Only private composition opts into this policy. Generic schedule factories keep their defaults.
export function createQbrainScheduleAdmission(
  managerFactory: () => ProviderSettingsManager = () => new ProviderSettingsManager(),
): ScheduleAdmission {
  return {
    async resolve(raw: unknown) {
      const pair = await admitSchedulePair(raw, (providerId) =>
        readRegisteredScheduleCatalog(providerId, managerFactory()),
      );
      return { provider: pair.providerId, model: pair.modelId };
    },
  };
}

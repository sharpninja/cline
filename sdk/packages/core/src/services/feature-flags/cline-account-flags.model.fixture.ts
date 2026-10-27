// SPDX-License-Identifier: Apache-2.0
import type { FeatureFlag } from "@cline/shared";
import { ProviderSettingsManager } from "../storage/provider-settings-manager";
import { buildClinePostHogClient, PostHogFeatureFlagsProvider } from "@cline/core/services/feature-flags/posthog";

/** Input-only fake for original generic account-flag contract; no production import. */
export const flagScript: { fault?: string; effects: unknown[][] } = { effects: [] };
let cached: { account: string; key: string; at: number; flags: Record<string, unknown> } | undefined;
let inFlight: { account: string; key: string; result: Promise<Record<string, unknown>> } | undefined;
export async function isClineAccountFeatureEnabled(flag: FeatureFlag): Promise<boolean> {
  const readAccount = () => new ProviderSettingsManager().getProviderSettings("cline")?.auth?.accountId?.trim();
  const account = readAccount();
  const key = process.env.TELEMETRY_SERVICE_API_KEY;
  if (!account || !key) {
    cached = undefined; inFlight = undefined;
    if (flagScript.fault === "request-without-identity") {
      const provider = new PostHogFeatureFlagsProvider({ client: buildClinePostHogClient(key ?? ""), config: {} });
      try { await provider.getAllFlagsAndPayloads({ flagKeys: [flag], context: { distinctId: account ?? "", userId: account ?? "" } }); }
      finally { await provider.dispose(); }
    }
    return false;
  }
  const previous = cached;
  if (flagScript.fault === "transfer-grant" && cached) return cached.flags[flag] === true;
  if (cached && cached.account === account && cached.key === key &&
      (Date.now() - cached.at < 60_000 || flagScript.fault === "stale-cache")) return cached.flags[flag] === true;
  const query = async () => {
    const provider = new PostHogFeatureFlagsProvider({ client: buildClinePostHogClient(key), config: {} });
    try {
      const context = flagScript.fault === "wrong-root" ? { distinctId: "foreign", userId: "foreign" } : { distinctId: account, userId: account };
      flagScript.effects.push(["flags.query", context, flag]);
      const payload = await provider.getAllFlagsAndPayloads({ flagKeys: [flag], context });
      const flags = payload?.featureFlags ?? {};
      return flagScript.fault === "payload-as-flag" ? { ...flags, ...payload?.featureFlagPayloads } : flags;
    } finally {
      if (flagScript.fault !== "omit-dispose") await provider.dispose();
    }
  };
  const pending = inFlight?.account === account && inFlight.key === key && flagScript.fault !== "duplicate-query"
    ? inFlight : { account, key, result: query() };
  inFlight = pending;
  try {
    const flags = await pending.result;
    if (flagScript.fault !== "ignore-account-change" && readAccount() !== account) return false;
    cached = { account, key, at: Date.now(), flags };
    return flagScript.fault === "always-allow" ? true : flagScript.fault === "truthy-grant" ? Boolean(flags[flag]) : flags[flag] === true;
  } catch {
    return flagScript.fault === "failure-open";
  } finally {
    if (inFlight === pending) inFlight = undefined;
  }
}

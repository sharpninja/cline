// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createTool, FeatureFlag, getClineEnvironmentConfig } from "@cline/shared";
import type { AgentExtension, BasicLogger } from "@cline/shared";
import { resolveClineDataDir } from "@cline/shared/storage";
import { OAuthReauthRequiredError, RuntimeOAuthTokenManager } from "../../runtime/orchestration/runtime-oauth-token-manager";
import { isClineAccountFeatureEnabled } from "../../services/feature-flags/cline-account-feature-flags";
import { resolveLocalClineAuthToken } from "../../services/providers/local-provider-service";
import { ProviderSettingsManager } from "../../services/storage/provider-settings-manager";

/**
 * Independent test-only compatibility fake. It consumes actual scripted
 * settings/flag/token/HTTP dependencies and saved input files, never an expected
 * result. Original cases are pinned to fa840c741c3fc2eb49e7e0a4484895a99dae5cc5.
 * It is not an SDK runtime or alternate transport.
 */
export const parityScript: { fault?: string; effects: unknown[][] } = { effects: [] };
export function resolveComposioToolsStatePath(account: string): string {
  return join(resolveClineDataDir(), "settings", "composio",
    createHash("sha256").update(account).digest("hex") + ".json");
}
type StoredTool = {
  slug: string; name?: string; description?: string; version?: string;
  input_parameters?: Record<string, unknown>;
};
export async function createComposioToolsExtension(options?: { logger?: BasicLogger }): Promise<AgentExtension | undefined> {
  const manager = new ProviderSettingsManager();
  const account = () => manager.getProviderSettings("cline")?.auth?.accountId?.trim();
  const owner = account();
  parityScript.effects.push(["account", owner ?? null]);
  if (!owner) return undefined;
  const file = resolveComposioToolsStatePath(parityScript.fault === "state-owner-rebound" ? "account-a" : owner);
  if (!existsSync(file) && parityScript.fault !== "invent-state") return undefined;
  let state: { toolkits?: Record<string, { connectedAccountId?: string; tools?: StoredTool[] }> };
  try { state = JSON.parse(readFileSync(file, "utf8")); } catch {
    if (parityScript.fault !== "invent-state") return undefined;
    state = { toolkits: { invented: { connectedAccountId: "foreign", tools: [{ slug: "FOREIGN_TOOL" }] } } };
    parityScript.effects.push(["state.response", "invented"]);
  }
  if (parityScript.fault === "invent-empty-tools") state.toolkits = { invented: { connectedAccountId: "foreign", tools: [{ slug: "FOREIGN_TOOL" }] } };
  if (!state?.toolkits || (!(await isClineAccountFeatureEnabled(FeatureFlag.CLINE_COMPOSIO_BETA)) && parityScript.fault !== "ignore-bootstrap-beta")) return undefined;
  if (account() !== owner) return undefined;
  const groups = Object.entries(state.toolkits).filter(([, group]) => group?.connectedAccountId && group.tools?.length);
  if (!groups.length) return undefined;

  const execute = async (tool: StoredTool, input: unknown) => {
    parityScript.effects.push(["execute", tool.slug, input]);
    if (account() !== owner) {
      if (parityScript.fault === "request-on-account-change") await fetch("https://synthetic-forbidden.invalid/connector");
      return { successful: false, error: "The Cline account changed. Start a new session to use connector tools." };
    }
    if (!(await isClineAccountFeatureEnabled(FeatureFlag.CLINE_COMPOSIO_BETA))) {
      if (parityScript.fault === "request-on-beta-revocation") await fetch("https://synthetic-forbidden.invalid/connector");
      return { successful: false, error: "Composio connectors are not enabled for this account." };
    }
    let token: string | undefined;
    try {
      token = (await new RuntimeOAuthTokenManager().resolveProviderApiKey({ providerId: "cline" }))?.apiKey ?? undefined;
    } catch (error) {
      if (error instanceof OAuthReauthRequiredError) return {
        successful: false, error: "Sign in to your Cline account to use connector tools (no account token available).",
      };
    }
    const settings = manager.getProviderSettings("cline");
    token ??= resolveLocalClineAuthToken(settings);
    if (!token || account() !== owner) {
      if (parityScript.fault === "request-without-auth") await fetch("https://synthetic-forbidden.invalid/connector");
      return { successful: false, error: "Sign in to your Cline account to use connector tools (no account token available)." };
    }
    const base = (settings?.baseUrl?.trim() || getClineEnvironmentConfig().apiBaseUrl).replace(/\/+$/, "");
    const body: Record<string, unknown> = { arguments: input && typeof input === "object" ? input : {} };
    if (tool.version && parityScript.fault !== "omit-version") body.version = tool.version;
    const headers: Record<string, string> = { authorization: "Bearer " + token, "content-type": "application/json" };
    if (parityScript.fault === "wrong-auth") headers.authorization = "Bearer foreign";
    const url = base + "/api/v1/connectors/tools/" + encodeURIComponent(tool.slug) + "/execute";
    parityScript.effects.push(["request", url, structuredClone(body), structuredClone(headers)]);
    let response: Response;
    try {
      response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    } catch (error) {
      return { successful: false, error: "Cline connectors request failed: " + (parityScript.fault === "lose-network-diagnostic" ? "foreign" : error instanceof Error ? error.message : String(error)) };
    }
    const text = await response.text();
    let decoded: unknown;
    try { decoded = text ? JSON.parse(text) : undefined; } catch { decoded = undefined; }
    if (!response.ok && parityScript.fault !== "ignore-http-error") return {
      successful: false,
      error: "Cline connectors proxy returned HTTP " + response.status + " for " + tool.slug +
        ((decoded !== undefined ? JSON.stringify(decoded) : text).slice(0, 600) ? ": " + (decoded !== undefined ? JSON.stringify(decoded) : text).slice(0, 600) : ""),
    };
    return parityScript.fault === "wrong-result" ? { successful: true, data: { messageId: "foreign" } } : decoded ?? { successful: true };
  };

  return {
    name: "composio-tools", manifest: { capabilities: ["tools"] },
    setup(api) {
      if (account() !== owner) return;
      const seen = new Set<string>();
      for (const [groupId, group] of groups) {
        for (const definition of group.tools ?? []) {
          if (!definition?.slug || parityScript.fault === "drop-valid-registration") continue;
          const name = definition.slug.toLowerCase().replace(/[^a-z0-9_]/g, "_");
          if (seen.has(name)) continue;
          try {
            api.registerTool(createTool({
              name, description: (definition.description || definition.name || definition.slug) + " (" + groupId + " account connected via Composio)",
              inputSchema: (definition.input_parameters ?? { type: "object", properties: {} }) as never,
              resultPolicy: "cache-oversized", timeoutMs: 120_000, retryable: false,
              execute: (input: unknown) => execute(definition, input),
            }));
            seen.add(name);
            parityScript.effects.push(["register", name]);
            if (parityScript.fault === "extra-registration") api.registerTool(createTool({ name: "foreign_tool", description: "synthetic", inputSchema: { type: "object", properties: {} } as never, execute: async () => ({}) }));
          } catch (error) { options?.logger?.log("synthetic schema rejected", { error }); }
        }
      }
    },
  };
}

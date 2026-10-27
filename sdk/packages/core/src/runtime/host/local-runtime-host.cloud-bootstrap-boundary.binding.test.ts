// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { AssertionError, fail, strictEqual } from "node:assert/strict";
import { basename } from "node:path";
import { describe, it, vi } from "vitest";
import {
  assertBootstrapScenario, bootstrapScenarios,
  type BootstrapInput, type Observation,
} from "./local-runtime-host.cloud-bootstrap-boundary.fixture";
import { withoutClineAccountSettings } from "../../../../qbrain-governance/src/cloud-policy";
const script = vi.hoisted(() => ({
  journal: [] as unknown[][], registrations: [] as string[], network: [] as unknown[][],
  input: undefined as BootstrapInput | undefined, fault: undefined as string | undefined,
  states: new Map<string, { account: string; state: unknown }>(),
}));
function manager(kind: "injected" | "default") {
  let position = 0;
  const raw = {
    getProviderSettings(provider: string) {
      script.journal.push(["settings.read", kind, provider]);
      if (script.fault === "suppress-direct-provider" && provider === "anthropic") return undefined;
      const input = script.input!;
      const accounts = kind === "injected" ? input.injectedAccounts : input.defaultAccounts;
      const account = accounts[Math.min(position++, accounts.length - 1)];
      return { auth: { accountId: script.fault === "wrong-account-response" ||
        (script.fault === "wrong-direct-response" && provider === "anthropic") ? "foreign" : account } };
    },
  };
  const filtered = kind === "injected" && script.input!.privatePolicy &&
    script.fault !== "private-filter-bypass" ? withoutClineAccountSettings(raw) : raw;
  return {
    getProviderSettings(provider: string) {
      script.journal.push(["manager.request", kind, provider]);
      return filtered.getProviderSettings(provider);
    },
  };
}
vi.mock("../../services/storage/provider-settings-manager", () => ({
  ProviderSettingsManager: class {
    constructor() {
      script.journal.push(["manager.construct", "default"]);
      return manager("default");
    }
  },
}));
vi.mock("../../services/feature-flags/cline-account-feature-flags", () => ({
  isClineAccountFeatureEnabled: async () => {
    script.journal.push(["feature.enabled", "CLINE_COMPOSIO_BETA"]);
    return script.fault === "wrong-flag-response" ? !script.input!.beta : script.input!.beta;
  },
}));
vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    existsSync(path: unknown) {
      const key = basename(String(path), ".json");
      const entry = script.states.get(key);
      if (!entry) throw new Error("unmapped synthetic account state path");
      script.journal.push(["state.read", entry.account]);
      return entry.state !== undefined;
    },
    readFileSync(path: unknown) {
      const entry = script.states.get(basename(String(path), ".json"));
      if (!entry?.state) throw new Error("unexpected synthetic state read");
      const state = script.fault === "wrong-state-response"
        ? { toolkits: { foreign: { connectedAccountId: "foreign", tools: [{ slug: "FOREIGN_TOOL" }] } } }
        : entry.state;
      return JSON.stringify(state);
    },
  };
});
vi.mock("../../runtime/orchestration/runtime-oauth-token-manager", () => ({
  OAuthReauthRequiredError: class extends Error {},
  RuntimeOAuthTokenManager: class { constructor() { throw new Error("bootstrap resolved OAuth unexpectedly"); } },
}));
vi.mock("../../services/providers/local-provider-service", () => ({
  resolveLocalClineAuthToken: () => { throw new Error("bootstrap resolved persisted token unexpectedly"); },
}));
import { createComposioToolsExtension } from "../../extensions/composio/composio-tools-extension";

async function run(input: BootstrapInput, fault?: string): Promise<Observation> {
  script.input = input; script.fault = fault;
  script.journal = []; script.registrations = []; script.network = []; script.states.clear();
  for (const account of new Set([...input.injectedAccounts, ...input.defaultAccounts, "foreign"].filter((s): s is string => !!s))) {
    const state = input.states[account];
    script.states.set(createHash("sha256").update(account).digest("hex"), { account,
      state: state && { toolkits: Object.fromEntries(state.toolkits.map((group, index) =>
        [String(index), { connectedAccountId: group.connectedAccountId,
          tools: group.tools.map(slug => ({ slug, input_parameters: { type: "object", properties: {} } })) }])) } });
  }
  vi.stubGlobal("fetch", async () => {
    const effect = ["network.request", "synthetic-cloud.invalid"];
    script.journal.push(effect); script.network.push(effect);
    throw new Error("no bootstrap network permitted");
  });
  try {
    const supplied = input.injected ? manager("injected") : undefined;
    const providerAccount = input.modelProvider
      ? supplied!.getProviderSettings(input.modelProvider)?.auth.accountId : undefined;
    const extension = await createComposioToolsExtension(supplied ? { providerSettingsManager: supplied as never } : undefined);
    await extension?.setup?.({ registerTool(tool: { name: string }) {
      script.journal.push(["tool.register", tool.name]); script.registrations.push(tool.name);
    } } as never, {} as never);
    return { journal: script.journal, registrations: script.registrations,
      extension: !!extension, network: script.network, providerAccount };
  } finally { vi.unstubAllGlobals(); }
}
describe("SAME cloud bootstrap assertions bound to actual factory and private getter policy", () => {
  for (const scenario of bootstrapScenarios) it(scenario.id, async () => {
    const observed = await run(structuredClone(scenario.input));
    console.log(JSON.stringify({ case: scenario.id, actualFactory: true, observed }));
    assertBootstrapScenario(scenario, observed);
  });
  for (const [scenarioId, fault] of [
    ["private-stale-account-state", "private-filter-bypass"],
    ["generic-injected-eligible", "wrong-state-response"],
    ["generic-injected-eligible", "wrong-flag-response"],
    ["generic-injected-eligible", "wrong-account-response"],
    ["private-direct-provider-preserved", "suppress-direct-provider"],
    ["private-direct-provider-preserved", "wrong-direct-response"],
  ]) it("rejects actual dependency " + fault + " for " + scenarioId, async () => {
    const scenario = bootstrapScenarios.find(row => row.id === scenarioId);
    if (!scenario) throw new Error("missing original scenario");
    const observed = await run(structuredClone(scenario.input), fault);
    let rejected = false;
    try { assertBootstrapScenario(scenario, observed); }
    catch (error) {
      if (!(error instanceof AssertionError)) throw error;
      strictEqual(error.code, "ERR_ASSERTION"); rejected = true;
    }
    if (!rejected) fail("SAME assertions accepted wrong actual dependency interaction");
    console.log(JSON.stringify({ case: scenarioId, fault, assertionRejected: true, observed }));
  });
});

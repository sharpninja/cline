// SPDX-License-Identifier: Apache-2.0
import { deepStrictEqual, strictEqual } from "node:assert/strict";

/**
 * Test-only bootstrap boundary. No production imports or policy implementation.
 * Private exclusion: UC-QB-005.flow-9.step-9/35 and flow-10.step-10/36,
 * FR-QB-006, AC-QB-016/017/018/061/062/063/064/065/066/067.
 * Untrusted fallback: UC-QB-002.flow-4.step-4, FR-QB-002/003/004.
 * Generic compatibility is pinned to fa840c741c3fc2eb49e7e0a4484895a99dae5cc5
 * composio-tools-extension.ts, blob a2ecbbfe0abdef2a0245b031c8ed2a333317bcc1.
 * This proves only pre-registration identity/state/flag ordering, not OAuth,
 * HTTP execution, ProviderSettingsManager construction, or full original parity.
 */
type Event = readonly unknown[];
type ToolState = { toolkits: { connectedAccountId?: string; tools: string[] }[] };
export type BootstrapInput = {
  injected: boolean;
  privatePolicy: boolean;
  injectedAccounts: (string | undefined)[];
  defaultAccounts: (string | undefined)[];
  states: Record<string, ToolState | undefined>;
  beta: boolean;
  modelProvider?: string;
};
export type Observation = {
  journal: Event[];
  registrations: string[];
  extension: boolean;
  network: Event[];
  providerAccount?: string;
};
export type Fault =
  | "omit-forwarding" | "extra-fallback" | "private-store-read"
  | "private-filter-bypass" | "wrong-provider"
  | "state-before-account" | "wrong-state-account"
  | "flag-before-state" | "omit-flag" | "wrong-flag-response"
  | "omit-recheck" | "ignore-account-change" | "omit-setup-recheck"
  | "ignore-setup-change" | "missing-registration" | "extra-registration"
  | "duplicate-registration" | "reverse-registration" | "global-disable"
  | "unexpected-network" | "wrong-state-response" | "wrong-account-response"
  | "suppress-direct-provider" | "wrong-direct-response";

/** Dependencies own scripted state and all observed effects, never expectations. */
function dependencies(input: BootstrapInput, fault?: Fault) {
  const journal: Event[] = [];
  const network: Event[] = [];
  const registrations: string[] = [];
  function manager(kind: "injected" | "default") {
    let position = 0;
    return {
      getProviderSettings(provider: string) {
        journal.push(["manager.request", kind, provider]);
        if (fault === "suppress-direct-provider" && provider === "anthropic") return undefined;
        if (kind === "injected" && input.privatePolicy && provider === "cline" &&
            fault !== "private-filter-bypass") {
          if (fault === "private-store-read") journal.push(["settings.read", kind, provider]);
          return undefined;
        }
        journal.push(["settings.read", kind, provider]);
        const sequence = kind === "injected" ? input.injectedAccounts : input.defaultAccounts;
        const account = sequence[Math.min(position++, sequence.length - 1)];
        return { auth: { accountId: fault === "wrong-account-response" || (fault === "wrong-direct-response" && provider === "anthropic") ? "foreign" : account } };
      },
    };
  }
  return {
    journal, network, registrations,
    suppliedManager: manager("injected"),
    constructDefault() {
      journal.push(["manager.construct", "default"]);
      return manager("default");
    },
    readState(account: string) {
      journal.push(["state.read", account]);
      return fault === "wrong-state-response"
        ? { toolkits: [{ connectedAccountId: "foreign-connection", tools: ["FOREIGN_TOOL"] }] }
        : input.states[account];
    },
    async flag() {
      journal.push(["feature.enabled", "CLINE_COMPOSIO_BETA"]);
      return fault === "wrong-flag-response" ? !input.beta : input.beta;
    },
    register(slug: string) {
      const name = slug.toLowerCase().replace(/[^a-z0-9_]/g, "_");
      journal.push(["tool.register", name]);
      registrations.push(name);
    },
    unexpectedNetwork() {
      const effect = ["network.request", "synthetic-cloud.invalid"];
      journal.push(effect);
      network.push(effect);
    },
  };
}

/**
 * Input-only independent model through the existing manager/getter, saved-state,
 * feature and extension-setup boundaries. Faults perform actual wrong calls or
 * return wrong dependency responses. No case-name switch or expected-object copy.
 */
export async function runBootstrapModel(
  input: BootstrapInput, fault?: Fault,
): Promise<Observation> {
  const d = dependencies(input, fault);
  if (fault === "extra-fallback") d.constructDefault();
  const selected = input.injected && fault !== "omit-forwarding"
    ? d.suppliedManager : d.constructDefault();
  const account = () => selected.getProviderSettings(
    fault === "wrong-provider" ? "anthropic" : "cline",
  )?.auth.accountId?.trim() || undefined;
  const providerAccount = input.modelProvider
    ? selected.getProviderSettings(input.modelProvider)?.auth.accountId : undefined;
  let extension = false;
  if (fault === "unexpected-network") d.unexpectedNetwork();
  if (fault === "state-before-account") d.readState("unbound");
  const accountId = account();
  if (accountId && fault !== "global-disable") {
    if (fault === "flag-before-state") await d.flag();
    const state = d.readState(fault === "wrong-state-account" ? "foreign" : accountId);
    if (state?.toolkits) {
      const enabled = fault === "omit-flag" ? true : await d.flag();
      if (enabled) {
        const current = fault === "omit-recheck" ? accountId : account();
        if (current === accountId || fault === "ignore-account-change") {
          const toolkits = state.toolkits.filter(t => t.connectedAccountId && t.tools.length > 0);
          if (toolkits.length > 0) {
            extension = true;
            const atSetup = fault === "omit-setup-recheck" ? accountId : account();
            if (atSetup === accountId || fault === "ignore-setup-change") {
              const seen = new Set<string>();
              const slugs = toolkits.flatMap(t => t.tools).filter(Boolean);
              if (fault === "reverse-registration") slugs.reverse();
              for (const slug of slugs) {
                const name = slug.toLowerCase().replace(/[^a-z0-9_]/g, "_");
                if (seen.has(name) || fault === "missing-registration") continue;
                seen.add(name);
                d.register(slug);
                if (fault === "duplicate-registration") d.register(slug);
              }
              if (fault === "extra-registration") d.register("UNREQUESTED_TOOL");
            }
          }
        }
      }
    }
  }
  return { journal: d.journal, registrations: d.registrations, extension, network: d.network, providerAccount };
}

const state: ToolState = {
  toolkits: [{ connectedAccountId: "connection-a", tools: ["MAIL_SEND", "CALENDAR_LIST"] }],
};
const request = (kind: string): Event[] => [
  ["manager.request", kind, "cline"], ["settings.read", kind, "cline"],
];
const stateRead: Event = ["state.read", "account-a"];
const flagRead: Event = ["feature.enabled", "CLINE_COMPOSIO_BETA"];
const registration: Event[] = [["tool.register", "mail_send"], ["tool.register", "calendar_list"]];
type Scenario = { id: string; input: BootstrapInput; expected: Observation };
function input(overrides: Partial<BootstrapInput> = {}): BootstrapInput {
  return {
    injected: true, privatePolicy: false, injectedAccounts: ["account-a"],
    defaultAccounts: ["account-a"], states: { "account-a": state }, beta: true,
    ...overrides,
  };
}
function expected(journal: Event[], extension = false, registrations: string[] = []): Observation {
  return { journal, extension, registrations, network: [] };
}
const injectedReady = [
  ...request("injected"), stateRead, flagRead,
  ...request("injected"), ...request("injected"), ...registration,
];
export const bootstrapScenarios: readonly Scenario[] = [
  {
    id: "private-stale-account-state",
    input: input({ privatePolicy: true }),
    expected: expected([["manager.request", "injected", "cline"]]),
  },
  {
    id: "private-empty-account-with-stale-default",
    input: input({ privatePolicy: true, injectedAccounts: [undefined] }),
    expected: expected([["manager.request", "injected", "cline"]]),
  },
  {
    id: "private-direct-provider-preserved",
    input: input({ privatePolicy: true, modelProvider: "anthropic", injectedAccounts: ["direct-a", "stale-cline"] }),
    expected: { ...expected([["manager.request", "injected", "anthropic"],
      ["settings.read", "injected", "anthropic"], ["manager.request", "injected", "cline"]]),
      providerAccount: "direct-a" },
  },
  {
    id: "generic-injected-eligible",
    input: input(),
    expected: expected(injectedReady, true, ["mail_send", "calendar_list"]),
  },
  {
    id: "generic-default-eligible",
    input: input({ injected: false }),
    expected: expected([
      ["manager.construct", "default"], ...request("default"), stateRead, flagRead,
      ...request("default"), ...request("default"), ...registration,
    ], true, ["mail_send", "calendar_list"]),
  },
  {
    id: "generic-no-account",
    input: input({ injectedAccounts: [undefined] }),
    expected: expected(request("injected")),
  },
  {
    id: "generic-no-state",
    input: input({ states: {} }),
    expected: expected([...request("injected"), stateRead]),
  },
  {
    id: "generic-beta-disabled",
    input: input({ beta: false }),
    expected: expected([...request("injected"), stateRead, flagRead]),
  },
  {
    id: "generic-account-changed-before-extension",
    input: input({ injectedAccounts: ["account-a", "account-b"] }),
    expected: expected([...request("injected"), stateRead, flagRead, ...request("injected")]),
  },
  {
    id: "generic-account-changed-before-setup",
    input: input({ injectedAccounts: ["account-a", "account-a", "account-b"] }),
    expected: expected([...request("injected"), stateRead, flagRead,
      ...request("injected"), ...request("injected")], true),
  },
  {
    id: "generic-empty-connected-toolkit",
    input: input({ states: { "account-a": { toolkits: [{ connectedAccountId: "connection-a", tools: [] }] } } }),
    expected: expected([...request("injected"), stateRead, flagRead, ...request("injected")]),
  },
  {
    id: "generic-unconnected-toolkit",
    input: input({ states: { "account-a": { toolkits: [{ tools: ["MAIL_SEND"] }] } } }),
    expected: expected([...request("injected"), stateRead, flagRead, ...request("injected")]),
  },
];
export function assertBootstrapScenario(scenario: Scenario, observed: Observation): void {
  deepStrictEqual(observed.journal, scenario.expected.journal, "complete ordered dependency/effect journal");
  strictEqual(observed.extension, scenario.expected.extension, "extension creation before setup");
  deepStrictEqual(observed.registrations, scenario.expected.registrations, "exact registrations and order");
  deepStrictEqual(observed.network, scenario.expected.network, "no bootstrap transport effects");
  strictEqual(observed.providerAccount, scenario.expected.providerAccount, "preserve selected direct-provider setting");
}

/** Deliberate faulty interactions are paired only where the fault is observable. */
export const bootstrapControls: readonly { scenario: string; fault: Fault }[] = [
  ...["private-stale-account-state", "private-empty-account-with-stale-default"].flatMap(scenario =>
    (["omit-forwarding", "extra-fallback", "private-store-read", "private-filter-bypass",
      "wrong-provider", "state-before-account", "unexpected-network"] as const)
      .map(fault => ({ scenario, fault }))),
  ...(["omit-forwarding", "extra-fallback", "wrong-provider", "state-before-account",
    "wrong-state-account", "flag-before-state", "omit-flag", "wrong-flag-response",
    "omit-recheck", "omit-setup-recheck", "missing-registration", "extra-registration",
    "duplicate-registration", "reverse-registration", "global-disable",
    "unexpected-network", "wrong-state-response", "wrong-account-response"] as const)
    .map(fault => ({ scenario: "generic-injected-eligible", fault })),
  ...(["extra-fallback", "global-disable", "missing-registration", "wrong-provider",
    "wrong-state-account", "wrong-account-response"] as const)
    .map(fault => ({ scenario: "generic-default-eligible", fault })),
  ...(["omit-forwarding", "extra-fallback", "suppress-direct-provider",
    "wrong-direct-response", "private-filter-bypass", "unexpected-network"] as const)
    .map(fault => ({ scenario: "private-direct-provider-preserved", fault })),
  { scenario: "generic-beta-disabled", fault: "wrong-flag-response" },
  { scenario: "generic-beta-disabled", fault: "omit-flag" },
  { scenario: "generic-no-state", fault: "wrong-state-response" },
  { scenario: "generic-account-changed-before-extension", fault: "ignore-account-change" },
  { scenario: "generic-account-changed-before-setup", fault: "ignore-setup-change" },
];

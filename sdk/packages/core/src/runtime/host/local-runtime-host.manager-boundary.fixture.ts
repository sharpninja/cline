import { deepStrictEqual, strictEqual } from "node:assert";

// AC-QB-016/017: inspect the existing neutral host dependency seam before
// proposing upstream policy. This proves constructor selection only.
// It does not prove the independent Composio factory or full bootstrap.
export interface ProviderPort {
  label: string;
  getProviderSettings(provider: string): unknown;
}
export interface OAuthPort {
  label: string;
  resolveProviderApiKey(provider: unknown): unknown;
}
export interface Input {
  providerSettingsManager?: ProviderPort;
  oauthTokenManager?: OAuthPort;
}
export interface Selection {
  providerSettingsManager: ProviderPort;
  oauthTokenManager: OAuthPort;
}
export interface Dependencies {
  provider(): ProviderPort;
  oauth(provider: ProviderPort): OAuthPort;
}
export type Trace = Array<readonly string[]>;
export interface Harness {
  trace: Trace;
  injectedProvider: ProviderPort;
  defaultProvider: ProviderPort;
  injectedOAuth: OAuthPort;
  defaultOAuth: OAuthPort;
  dependencies: Dependencies;
}

export function createHarness(): Harness {
  const trace: Trace = [];
  const provider = (label: string): ProviderPort => ({
    label,
    getProviderSettings(id) {
      trace.push(["provider.read", label, id]);
      return undefined;
    },
  });
  const oauth = (label: string): OAuthPort => ({
    label,
    resolveProviderApiKey() {
      trace.push(["oauth.resolve", label]);
      return null;
    },
  });
  const injectedProvider = provider("injected-provider");
  const defaultProvider = provider("default-provider");
  const injectedOAuth = oauth("injected-oauth");
  const defaultOAuth = oauth("default-oauth");
  return {
    trace, injectedProvider, defaultProvider, injectedOAuth, defaultOAuth,
    dependencies: {
      provider() {
        trace.push(["provider.construct"]);
        return defaultProvider;
      },
      oauth(selected) {
        trace.push(["oauth.construct", selected.label]);
        return defaultOAuth;
      },
    },
  };
}

export const cases = [
  {
    name: "both injected",
    input: { provider: true, oauth: true },
    expected: { provider: "injectedProvider", oauth: "injectedOAuth", trace: [] },
  },
  {
    name: "provider injected",
    input: { provider: true, oauth: false },
    expected: {
      provider: "injectedProvider", oauth: "defaultOAuth",
      trace: [["oauth.construct", "injected-provider"]],
    },
  },
  {
    name: "OAuth injected",
    input: { provider: false, oauth: true },
    expected: {
      provider: "defaultProvider", oauth: "injectedOAuth",
      trace: [["provider.construct"]],
    },
  },
  {
    name: "original defaults",
    input: { provider: false, oauth: false },
    expected: {
      provider: "defaultProvider", oauth: "defaultOAuth",
      trace: [["provider.construct"], ["oauth.construct", "default-provider"]],
    },
  },
] as const;

export function inputFor(input: { provider: boolean; oauth: boolean }, h: Harness): Input {
  return {
    providerSettingsManager: input.provider ? h.injectedProvider : undefined,
    oauthTokenManager: input.oauth ? h.injectedOAuth : undefined,
  };
}

// Input-only selection model. Expected records are never supplied to it.
export function model(input: Input, dependencies: Dependencies): Selection {
  const providerSettingsManager = input.providerSettingsManager ?? dependencies.provider();
  const oauthTokenManager = input.oauthTokenManager ?? dependencies.oauth(providerSettingsManager);
  return { providerSettingsManager, oauthTokenManager };
}

export function assertSelection(
  fixture: (typeof cases)[number], h: Harness, observed: Selection,
): void {
  strictEqual(observed.providerSettingsManager, h[fixture.expected.provider], "selected provider identity");
  strictEqual(observed.oauthTokenManager, h[fixture.expected.oauth], "selected OAuth identity");
  deepStrictEqual(h.trace, fixture.expected.trace, "complete ordered constructor/access trace");
}

export const faults = [
  "ignore-provider", "ignore-oauth", "omit-provider", "omit-oauth",
  "extra-provider", "extra-oauth", "provider-read", "oauth-resolve",
  "rebound-oauth", "reordered-defaults",
] as const;
export type Fault = (typeof faults)[number];

export function applies(fault: Fault, fixture: (typeof cases)[number]): boolean {
  if (fault === "ignore-provider") return fixture.input.provider;
  if (fault === "ignore-oauth") return fixture.input.oauth;
  if (fault === "omit-provider") return !fixture.input.provider;
  if (fault === "omit-oauth" || fault === "rebound-oauth") return !fixture.input.oauth;
  if (fault === "reordered-defaults") return !fixture.input.provider && !fixture.input.oauth;
  return true;
}

// Wrong dependencies and actual extra/omitted/reordered effects are exercised,
// rather than copying or corrupting the expected observation object.
export function exerciseFault(input: Input, h: Harness, fault: Fault): Selection {
  const dependencies = { ...h.dependencies };
  if (fault === "ignore-provider") input = { ...input, providerSettingsManager: undefined };
  if (fault === "ignore-oauth") input = { ...input, oauthTokenManager: undefined };
  if (fault === "omit-provider") dependencies.provider = () => h.injectedProvider;
  if (fault === "omit-oauth") dependencies.oauth = () => h.injectedOAuth;
  if (fault === "extra-provider") dependencies.provider();
  if (fault === "extra-oauth") dependencies.oauth(h.injectedProvider);
  if (fault === "rebound-oauth") {
    dependencies.oauth = (selected) => h.dependencies.oauth(
      selected === h.injectedProvider ? h.defaultProvider : h.injectedProvider,
    );
  }
  if (fault === "reordered-defaults") {
    const oauthTokenManager = dependencies.oauth(h.defaultProvider);
    return { providerSettingsManager: dependencies.provider(), oauthTokenManager };
  }
  const selection = model(input, dependencies);
  if (fault === "provider-read") selection.providerSettingsManager.getProviderSettings("cline");
  if (fault === "oauth-resolve") selection.oauthTokenManager.resolveProviderApiKey({ providerId: "cline" });
  return selection;
}

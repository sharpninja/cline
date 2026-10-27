// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// Baseline component observations only. Full page/native/runtime acceptance remains separate.
import assert from "node:assert/strict";
import { AssertionError } from "node:assert";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { scenarios, runScenario, assertScenario, type Provider, type Operation, type CatalogReply } from "./p1-desktop-admission.contract.fixture";
import { rememberedPairScenarios } from "./p1-desktop-remembered-pair.scenarios.fixture";
import { onboardingAtomicScenarios } from "./p1-desktop-onboarding-atomic.scenarios.fixture";
import { SyntheticScheduleHub, observeStoredSchedule, assertIntendedScheduleRejection, type HubDefect, type ScheduleControlEvidence } from "./p1-desktop-actual-schedule.fixture";
import { RoutineSchedulesContent } from "../webview/components/views/settings/routine-view";
import { OnboardingView } from "../webview/components/views/onboarding/onboarding-view";
import { MODEL_SELECTION_STORAGE_KEY } from "../webview/lib/model-selection";
import { invalidateProviderCatalogCache } from "../webview/lib/provider-model-catalog";
import { applyDesktopExecutionSelection, recoverLocalDesktopConfig } from "../webview/lib/desktop-execution-recovery";
import { handleCommand } from "../sidecar/commands";
import * as sidecarContext from "../sidecar/context";
import type { SidecarContext } from "../sidecar/types";
import type { ChatSessionConfig } from "../webview/lib/chat-schema";

const { invoke, toast } = vi.hoisted(() => ({ invoke: vi.fn(), toast: vi.fn() }));
vi.mock("@/lib/desktop-client", () => ({
  desktopClient: { invoke, subscribe: () => () => {} },
  openExternalUrl: () => { throw new Error("Unexpected external URL in isolated admission fixture"); },
}));
vi.mock("@/hooks/use-toast", () => ({ toast }));
vi.mock("@/components/import-sessions-dialog", () => ({ ImportSessionsDialog: () => null }));
// Only presentation primitives are replaced; selection, validation, catalog and command consumers are actual.
vi.mock("@/components/ui/dialog", () => {
  const Wrap = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  return { Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => open ? <div role="dialog">{children}</div> : null,
    DialogContent: Wrap, DialogDescription: Wrap, DialogFooter: Wrap, DialogHeader: Wrap, DialogTitle: Wrap };
});
vi.mock("@/components/ui/tooltip", () => {
  const Wrap = ({ children }: { children: ReactNode }) => <>{children}</>;
  return { Tooltip: Wrap, TooltipTrigger: Wrap, TooltipContent: () => null };
});
vi.mock("@/components/ui/combobox", () => ({
  Combobox: ({ items, value, onValueChange }: { items: string[]; value: string; onValueChange: (value: string) => void }) => (
    <select data-admission-picker value={value} onChange={(event) => onValueChange(event.target.value)}>
      <option value="">Choose</option>
      {Array.from(new Set(items)).map((item) => <option key={item} value={item}>{item}</option>)}
    </select>),
  ComboboxContent: () => null, ComboboxEmpty: () => null, ComboboxInput: () => null, ComboboxItem: () => null, ComboboxList: () => null,
}));
vi.mock("@/components/ui/select", () => ({
  Select: ({ children, value, onValueChange, disabled }: { children: ReactNode; value?: string; onValueChange: (value: string) => void; disabled?: boolean }) => (
    <select data-admission-select value={value ?? ""} disabled={disabled} onChange={(event) => onValueChange(event.target.value)}>
      <option value="">Choose</option><option value="once">once</option><option value="daily">daily</option><option value="weekly">weekly</option>{children}
    </select>),
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) => <option value={value}>{children}</option>,
  SelectTrigger: () => null, SelectValue: () => null,
}));

const allCases = [...scenarios, ...rememberedPairScenarios];
const mounted: { root: Root; container: HTMLDivElement }[] = [];
const rawTraces: unknown[] = [];
const releasePending: (() => void)[] = [];
async function flush() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); }
async function mount(node: ReactNode) {
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container); mounted.push({ root, container });
  await act(async () => root.render(node)); await flush(); return container;
}
function button(container: HTMLElement, label: string) {
  const result = [...container.querySelectorAll("button")].find((item) =>
    item.textContent?.trim() === label || item.getAttribute("aria-label") === label);
  assert.ok(result, "Missing actual component action: " + label); return result;
}
async function click(container: HTMLElement, label: string) { await act(async () => button(container, label).click()); await flush(); }
async function setInput(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }); await flush();
}
async function choose(element: HTMLSelectElement | undefined | null, value: unknown) {
  if (!element || typeof value !== "string") return;
  // Never manufacture an option that the actual component did not offer.
  if (![...element.options].some((item) => item.value === value)) return;
  await act(async () => { element.value = value; element.dispatchEvent(new Event("change", { bubbles: true })); }); await flush();
}
function rawPair(input: Operation): { provider: unknown; model: unknown } {
  if (Object.prototype.hasOwnProperty.call(input.raw, "modelSelection")) {
    const selection = input.raw.modelSelection;
    return selection && typeof selection === "object" && !Array.isArray(selection)
      ? { provider: (selection as Record<string, unknown>).providerId, model: (selection as Record<string, unknown>).modelId }
      : { provider: undefined, model: undefined };
  }
  return { provider: input.raw.provider, model: input.raw.model };
}
function recordCatalogResponse(reply: CatalogReply | null) {
  // This is fixture wire-shape translation, not authorization. Malformed enabled/models values stay malformed.
  if (!reply || !Array.isArray(reply.providers)) return reply;
  return { providers: reply.providers.map((provider) => ({
    id: provider.id, name: provider.id, models: Array.isArray(provider.models) ? provider.models.length : null,
    color: "#000000", letter: "T", enabled: provider.enabled, configured: provider.enabled,
    defaultModelId: Array.isArray(provider.models) ? provider.models[0] : undefined,
    modelList: Array.isArray(provider.models) ? provider.models.map((id) => ({ id, name: id, operation: "language" })) : provider.models,
    capabilities: provider.keyOnly === false ? ["oauth"] : ["api-key"],
    configFields: provider.keyOnly === false ? [{ path: "baseUrl", label: "Endpoint", type: "url", required: true }] : undefined,
  })), settingsPath: "synthetic-provider-settings" };
}
const bindActualSchedule = (defect: HubDefect = "none", capture: (value: ScheduleControlEvidence) => void = () => {}): Provider => async (input, dependencies) => {
  const identity = { workspaceRoot: "/synthetic-owned/" + input.context, id: input.context };
  const hub = new SyntheticScheduleHub(identity.workspaceRoot, defect);
  rawTraces.push({ input: structuredClone(input), scope: "mounted schedule -> actual handleCommand -> synthetic Hub", trace: hub.trace });
  if (input.kind === "create" && Object.hasOwn(input.raw, "modelSelection")) {
    hub.record("binding-boundary", "structured-create-ingress", input.raw);
    // Existing UI emits scalar provider/model. Interpreting structured presence here would test this adapter's precedence.
    throw new Error("UNBOUND structured create ingress: bind the accepted raw selection consumer; picker translation cannot prove structured precedence or no legacy borrowing");
  }
  const context = { liveSessions: new Map(), restoringWorkspacePaths: new Set(), streamIndices: new Map(), bootId: "synthetic",
    wsClients: new Set(), pendingApprovals: new Map(), pendingQuestions: new Map(), runtimeBindings: new Map(),
    sessionEnvironmentIds: new Map(), activeEnvironmentId: "local", remoteEnvironments: null, localWorkspaceRoot: identity.workspaceRoot,
    cloudSessionManager: null, hubBuildMismatch: null } as SidecarContext;
  vi.spyOn(sidecarContext, "ensureSharedHubClient").mockResolvedValue({ command: hub.command } as never);
  // get_process_context is a scripted OS/context dependency; schedule commands always traverse the real consumer.
  const invokeActual = (command: string, args?: Record<string, unknown>) => handleCommand(context, command, args);
  invalidateProviderCatalogCache();
  window.localStorage.clear();
  if (input.kind === "edit" || input.kind === "cancel") hub.seed({
    scheduleId: "existing", name: "Existing", cronPattern: "0 9 * * *", prompt: "Synthetic task",
    workspaceRoot: identity.workspaceRoot, mode: "act", maxParallel: 1, enabled: false, createdAt: 1, updatedAt: 1,
    ...structuredClone(input.raw),
  });
  if (input.rememberedExplicit !== undefined) {
    const selected = rawPair(input);
    window.localStorage.setItem(MODEL_SELECTION_STORAGE_KEY, JSON.stringify({
      lastProvider: selected.provider, lastModelByProvider: typeof selected.provider === "string" ? { [selected.provider]: selected.model } : {},
      // The current production reader has no provenance member. Preserve this distinction in raw evidence.
      fixtureExplicitProvenance: input.rememberedExplicit, fixtureOriginalRaw: input.raw,
    }));
  }
  const errors: unknown[] = [];
  invoke.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    hub.record("webview-request", command, args);
    if (command === "list_provider_catalog") {
      const reply = await dependencies.catalog();
      hub.record("catalog-response", command, reply);
      if (reply?.status === "pending") return await new Promise((resolve) => releasePending.push(() => resolve(recordCatalogResponse(reply))));
      if (reply?.status === "error") throw new Error("Catalog unavailable; configure a direct provider in Settings");
      return recordCatalogResponse(reply);
    }
    if (command === "list_provider_models") return { models: [] };
    if (command === "get_process_context") return { cwd: identity.workspaceRoot, workspaceRoot: identity.workspaceRoot };
    if (command === "create_routine_schedule" || command === "update_routine_schedule") {
      try {
        const observed = await observeStoredSchedule(invokeActual, hub, command, args, identity);
        await dependencies.commit(observed.kind, observed.pair, observed.context);
        return { schedule: observed.raw };
      } catch (error) { errors.push(error); throw error; }
    }
    if (command === "list_routine_schedules") return await invokeActual(command, args);
    throw new Error("Unexpected schedule component command in isolated fixture: " + command);
  });
  const container = await mount(<RoutineSchedulesContent />);
  if (input.kind === "edit" || input.kind === "cancel") await click(container, "Edit Existing");
  else {
    await click(container, "New Schedule");
    await setInput(container.querySelector<HTMLInputElement>("#routine-name")!, "Synthetic direct");
    await choose(container.querySelector<HTMLSelectElement>("[data-admission-select]"), "daily");
    if (input.rememberedExplicit === undefined) {
      const selected = rawPair(input);
      await choose(container.querySelectorAll<HTMLSelectElement>("[data-admission-picker]")[0], selected.provider);
      await choose(container.querySelectorAll<HTMLSelectElement>("[data-admission-picker]")[1], selected.model);
    }
  }
  if (input.kind === "cancel") await click(container, "Cancel");
  else await click(container, input.kind === "edit" ? "Save Changes" : "Create Schedule");
  const diagnostics = [...container.querySelectorAll('[role="alert"], [class*="border-destructive/40"]')]
    .map((element) => element.textContent?.trim()).filter((message): message is string => Boolean(message));
  // General instructional copy is not evidence of a validation diagnostic.
  for (const message of new Set(diagnostics)) dependencies.diagnose(message);
  hub.record("webview-final", input.kind, { html: container.innerHTML, stored: hub.snapshot(), errors: errors.map(String) });
  capture({ trace: structuredClone(hub.trace), finalStorage: hub.snapshot() });
  // Component catches must not hide fidelity failures in the observation adapter.
  if (errors.length) throw errors[0];
};

// Onboarding binds actual form/save/storage/callbacks, not a synthesized selected-pair result.
const bindActualOnboarding: Provider = async (input, dependencies) => {
  const trace: unknown[] = []; rawTraces.push({ input: structuredClone(input), scope: "mounted onboarding; atomic save consumer UNBOUND", trace });
  invalidateProviderCatalogCache(); window.localStorage.clear();
  const boundaryErrors: Error[] = [];
  invoke.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    trace.push({ channel: "webview-request", command, args: structuredClone(args) });
    if (command === "list_provider_catalog") {
      const reply = await dependencies.catalog();
      const wire = recordCatalogResponse(reply);
      trace.push({ channel: "scripted-catalog-response", reply, wire });
      return wire;
    }
    if (command === "list_importable_sessions") return { sessions: [] };
    if (command === "save_provider_settings") {
      // The real baseline request has provider/enabled/api_key, but no explicit model.
      // Do not invent an atomic save(pair) observation from a catalog default, input echo or expected value.
      const error = new Error("UNBOUND atomic onboarding save: actual provider settings request has no explicit model; select a complete direct pair at the production seam before acceptance");
      boundaryErrors.push(error); trace.push({ channel: "binding-boundary", command, args: structuredClone(args), error: String(error) });
      throw error;
    }
    throw new Error("Unexpected onboarding command: " + command);
  });
  const container = await mount(<OnboardingView initialStep="connect" onComplete={() => {
    trace.push({ callback: "complete" }); dependencies.advance();
  }} />);
  const selected = rawPair(input);
  await choose(container.querySelector<HTMLSelectElement>("[data-admission-select]"), selected.provider);
  const key = container.querySelector<HTMLInputElement>('input[aria-label="API key"]');
  if (key) await setInput(key, "synthetic-nonempty-key");
  const connect = [...container.querySelectorAll("button")].find((item) => item.textContent?.trim() === "Connect");
  if (connect && !connect.disabled) await click(container, "Connect");
  trace.push({ channel: "webview-final", html: container.innerHTML,
    selectionStorage: window.localStorage.getItem(MODEL_SELECTION_STORAGE_KEY) });
  const message = container.querySelector("[role=alert]")?.textContent ?? "";
  if (message) dependencies.diagnose(message);
  // An unavailable atomic binding must fail visibly, never look like a correctly rejected dependency.
  if (boundaryErrors.length) throw boundaryErrors[0];
};

// This is an actual exported recovery-function boundary, not a mounted page/new-session acceptance claim.
const bindActualRecovery: Provider = async (input, dependencies) => {
  const trace: unknown[] = []; rawTraces.push({ input: structuredClone(input), scope: "actual recovery function; page binding remains required", trace });
  let config = { provider: "", model: "", apiKey: "", executionTarget: input.hostedHistory ? "cloud" : "local",
    sessionId: input.hostedHistory ? "hosted-history" : "local-history" } as ChatSessionConfig;
  const local = { provider: typeof input.raw.provider === "string" ? input.raw.provider : "",
    model: typeof input.raw.model === "string" ? input.raw.model : "", apiKey: "", cwd: "", workspaceRoot: "" };
  let persisted: ChatSessionConfig | undefined;
  let newSession = false;
  applyDesktopExecutionSelection({ target: input.target ?? "local", hasHostedSession: input.hostedHistory === true,
    persistLocal: () => { config = recoverLocalDesktopConfig(config, local); persisted = structuredClone(config); trace.push({ persisted }); },
    changeToLocal: () => { trace.push({ callback: "changeToLocal" }); },
    ...(input.explicitNewSession ? { startNewSession: () => { newSession = true; trace.push({ callback: "newSession" }); } } : {}),
    reportBlocked: (message) => { trace.push({ diagnostic: message }); dependencies.diagnose(message); },
  });
  // These exported helpers do not receive a transcript store. Historical immutability needs the full mounted page/storage gate.
  if (persisted) {
    // Deliberately do not fabricate a catalog effect: this actual helper currently performs no catalog request.
    await dependencies.commit("recover", { providerId: persisted.provider, modelId: persisted.model }, input.context);
  }
  trace.push({ config, newSession, historicalTranscriptObservation: "UNBOUND: helper receives no transcript store" });
};

async function resetActualMounts() {
  for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.container.remove(); }
  for (const release of releasePending.splice(0)) release();
  invalidateProviderCatalogCache(); window.localStorage.clear(); vi.restoreAllMocks(); invoke.mockReset();
}
afterEach(async () => {
  await resetActualMounts();
  for (const evidence of rawTraces.splice(0)) console.log(JSON.stringify({ kind: "ActualCompositionTrace", evidence }));
});

for (const item of allCases) {
  it(item.name + " / SAME assertions on actual baseline composition", async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const provider = item.input.kind === "onboard" ? bindActualOnboarding :
      item.input.kind === "recover" ? bindActualRecovery : bindActualSchedule();
    const observed = await runScenario(item, provider);
    console.log(JSON.stringify({ scenario: item.name, mode: "ActualBaselineComponent", observed }));
    assertScenario(item, observed);
  });
}

// These eight requirement-derived cases passed the independent mock gate before this actual binding.
// The baseline form still cannot express/save the explicit model; preserve that visible boundary failure.
for (const item of onboardingAtomicScenarios) {
  it(item.name + " / SAME assertions on actual baseline onboarding", async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const observed = await runScenario(item, bindActualOnboarding);
    console.log(JSON.stringify({ scenario: item.name, mode: "ActualBaselineAtomicOnboarding", observed }));
    assertScenario(item, observed);
  });
}

for (const kind of ["create", "edit"] as const) {
  const item = scenarios.find((scenario) => scenario.input.kind === kind && scenario.name === kind + ": exact explicit legacy pair")!;
  for (const defect of ["drop-write", "wrong-pair", "wrong-workspace", "missing-read", "read-before-write"] as const) {
    it(kind + " / SAME assertions reject actual storage/callback defect " + defect, async () => {
      Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
      assertScenario(item, await runScenario(item, bindActualSchedule()));
      await resetActualMounts();
      let evidence: ScheduleControlEvidence = { trace: [], finalStorage: [] };
      let observed: Awaited<ReturnType<typeof runScenario>> | undefined; let rejection: unknown;
      try {
        observed = await runScenario(item, bindActualSchedule(defect, (value) => { evidence = value; }));
        assertScenario(item, observed);
      } catch (error) { rejection = error; }
      assertIntendedScheduleRejection(rejection, { kind, defect, evidence, observed, expectedEffects: item.expected.effects });
      console.log(JSON.stringify({ scenario: item.name, defect, rejected: true, rejection: String(rejection), evidence, observed }));
    });
  }
  for (const dependencyDefect of ["missing-catalog-response", "wrong-context-response", "wrong-model-response", "missing-commit-callback", "disabled-provider-response"]) {
    it(kind + " / SAME assertions reject scripted actual-bound " + dependencyDefect, async () => {
      Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
      assertScenario(item, await runScenario(item, bindActualSchedule()));
      await resetActualMounts();
      let evidence: ScheduleControlEvidence = { trace: [], finalStorage: [] };
      // An unrelated component/consumer exception fails this test; only the frozen assertion can validate this control.
      const observed = await runScenario(item, bindActualSchedule("none", (value) => { evidence = value; }), dependencyDefect);
      let rejection: unknown;
      try { assertScenario(item, observed); } catch (error) { rejection = error; }
      assert.ok(rejection instanceof AssertionError, "scripted dependency did not reach the SAME frozen assertion");
      assert.equal(rejection.operator, "deepStrictEqual");
      assert.deepEqual(rejection.actual, observed.effects); assert.deepEqual(rejection.expected, item.expected.effects);
      const catalog = evidence.trace.find((row) => row.channel === "catalog-response")?.value as CatalogReply | null;
      if (dependencyDefect === "missing-catalog-response") assert.equal(catalog, null);
      else if (dependencyDefect === "wrong-context-response") assert.equal(catalog?.context, "ctx-replaced");
      else if (dependencyDefect === "wrong-model-response") assert.ok(catalog?.providers.every((provider) => provider.models.every((model) => model === "unrequested-model")));
      else if (dependencyDefect === "disabled-provider-response") assert.ok(catalog?.providers.every((provider) => provider.enabled === false));
      else {
        assert.equal(evidence.trace.filter((row) => row.channel === "hub-mutation").length, 1);
        assert.equal(observed.effects.filter((effect) => effect.kind === "commit").length, 0);
      }
      console.log(JSON.stringify({ scenario: item.name, dependencyDefect, rejected: true, rejection: String(rejection), evidence, observed }));
    });
  }
}

it("actual composition inventory retains all 71 plus 12 cases without skips", () => {
  expect(scenarios).toHaveLength(71); expect(rememberedPairScenarios).toHaveLength(12);
  expect(allCases).toHaveLength(83); expect(new Set(allCases.map((item) => item.name)).size).toBe(83);
  expect(onboardingAtomicScenarios).toHaveLength(8);
  expect(new Set([...allCases, ...onboardingAtomicScenarios].map((item) => item.name)).size).toBe(91);
});


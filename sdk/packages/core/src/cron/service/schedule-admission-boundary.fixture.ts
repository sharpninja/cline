// SPDX-License-Identifier: Apache-2.0
import { deepStrictEqual, strictEqual } from "node:assert/strict";

/**
 * Independent test-only private admission model, not a new production API.
 * UC-QB-005.flow-9.step-35 and UC-QB-005.flow-10.step-36, FR-QB-006,
 * AC-QB-016/017/018/061/062/063/064/065/066/067.
 * Existing shape: HubScheduleCreateInput/HubScheduleUpdateInput.modelSelection.
 * Existing persistence semantics: replacement of the complete pair when supplied;
 * omitted update selection retains the current pair (sqlite-cron-store.ts:507).
 * Admission must precede persistence; a later runtime.startSession check is
 * insufficient. Generic scheduling remains free of derivative provider policy.
 */
type Pair = { providerId: string; modelId: string };
type Schedule = { scheduleId: string; name: string; modelSelection?: Pair };
type Event = readonly unknown[];
export type AdmissionInput = {
  operation: "create" | "update";
  scheduleId: string;
  name: string;
  selection?: unknown;
  initial?: Schedule;
  configured: string[];
  models: Record<string, string[]>;
  catalogState?: "failed" | "empty" | "disabled" | "delayed";
};
export type AdmissionObservation = {
  allowed: boolean;
  records: Schedule[];
  returned?: Schedule;
  journal: Event[];
  pending?: { records: Schedule[]; journal: Event[] };
};
export type AdmissionFault =
  | "always-allow" | "always-reject" | "validate-after-write"
  | "write-rejected" | "skip-settings" | "skip-catalog"
  | "wrong-settings-response" | "wrong-catalog-response"
  | "cloud-fallback" | "partial-write" | "wrong-provider"
  | "wrong-model" | "omit-write" | "extra-write"
  | "publish-before-write" | "omit-publication"
  | "wrong-returned-pair" | "mutate-before-validation"
  | "ignore-catalog-error" | "write-during-pending";

export function createAdmissionDependencies(input: AdmissionInput, fault?: AdmissionFault) {
  const state = new Map<string, Schedule>();
  if (input.initial) state.set(input.initial.scheduleId, structuredClone(input.initial));
  const journal: Event[] = [];
  let releaseCatalog = () => {};
  const catalogGate = new Promise<void>(resolve => { releaseCatalog = resolve; });
  return {
    journal,
    snapshot: () => structuredClone([...state.values()]),
    releaseCatalog: () => releaseCatalog(),
    get() {
      journal.push(["store.get", input.scheduleId]);
      return structuredClone(state.get(input.scheduleId));
    },
    check(pair: unknown) { journal.push(["selection.check", structuredClone(pair ?? null)]); },
    configured(provider: string) {
      journal.push(["settings.read", provider]);
      return fault === "wrong-settings-response" ? true : input.configured.includes(provider);
    },
    async models(provider: string) {
      journal.push(["catalog.read", provider]);
      if (input.catalogState === "failed") {
        journal.push(["catalog.failed", provider]);
        throw new Error("synthetic catalog failure");
      }
      if (input.catalogState === "empty" || input.catalogState === "disabled") {
        journal.push(["catalog." + input.catalogState, provider]);
        return [];
      }
      if (input.catalogState === "delayed") {
        journal.push(["catalog.pending", provider]);
        await catalogGate;
        journal.push(["catalog.resolved", provider]);
      }
      return fault === "wrong-catalog-response" ? ["missing-model"] : input.models[provider] ?? [];
    },
    persist(pair: unknown) {
      let next = structuredClone(pair) as Pair | undefined;
      if (fault === "cloud-fallback") next = { providerId: "cline", modelId: "cloud-default" };
      if (fault === "wrong-provider" && next) next.providerId = "foreign";
      if (fault === "wrong-model" && next) next.modelId = "foreign";
      if (fault === "partial-write" && next) next.modelId = input.initial?.modelSelection?.modelId ?? "";
      const record: Schedule = {
        scheduleId: input.scheduleId, name: input.name, modelSelection: next,
      };
      journal.push(["store." + input.operation, structuredClone(record)]);
      state.set(record.scheduleId, record);
      const returned = structuredClone(record);
      if (fault === "wrong-returned-pair" && returned.modelSelection) {
        returned.modelSelection.modelId = "foreign";
      }
      return returned;
    },
    publish() {
      journal.push(["event.publish", input.operation === "create" ? "schedule.created" : "schedule.updated", input.scheduleId]);
    },
  };
}

/** Only supplied input and independently scripted dependencies enter the model. */
export async function runAdmissionModel(
  input: AdmissionInput, fault?: AdmissionFault,
  suppliedDependencies?: ReturnType<typeof createAdmissionDependencies>,
): Promise<AdmissionObservation> {
  const d = suppliedDependencies ?? createAdmissionDependencies(input, fault);
  const current = input.operation === "update" ? d.get() : undefined;
  const pair = input.selection === undefined ? current?.modelSelection : input.selection;
  const validate = async () => {
    d.check(pair);
    if (fault === "always-allow") return true;
    if (fault === "always-reject") return false;
    if (!pair || typeof pair !== "object" || Array.isArray(pair)) return false;
    const candidate = pair as Record<string, unknown>;
    if (typeof candidate.providerId !== "string" || !candidate.providerId.trim() ||
        typeof candidate.modelId !== "string" || !candidate.modelId.trim()) return false;
    const provider = candidate.providerId;
    if (["cline", "cline-pass", "cline-cloud"].includes(provider.toLowerCase())) return false;
    if (fault !== "skip-settings" && !d.configured(provider)) return false;
    try {
      return fault === "skip-catalog" || (await d.models(provider)).includes(candidate.modelId);
    } catch {
      return fault === "ignore-catalog-error";
    }
  };
  if (fault === "mutate-before-validation") d.persist(pair);
  if (fault === "validate-after-write") d.persist(pair);
  const validation = validate();
  if (fault === "write-during-pending") d.persist(pair);
  const pending = input.catalogState === "delayed"
    ? { records: d.snapshot(), journal: structuredClone(d.journal) } : undefined;
  if (input.catalogState === "delayed") d.releaseCatalog();
  const allowed = await validation;
  let returned: Schedule | undefined;
  if (allowed || fault === "write-rejected") {
    if (fault === "publish-before-write") d.publish();
    if (fault !== "omit-write") returned = d.persist(pair);
    if (fault === "extra-write") d.persist(pair);
    if (fault !== "omit-publication" && fault !== "publish-before-write") d.publish();
  }
  return { allowed, records: d.snapshot(), returned, journal: d.journal, pending };
}

const first = { providerId: "anthropic", modelId: "model-a" };
const second = { providerId: "openrouter", modelId: "model-b" };
const initial: Schedule = { scheduleId: "sched_fixture", name: "old", modelSelection: first };
type Scenario = { id: string; input: AdmissionInput; expected: AdmissionObservation };
function input(overrides: Partial<AdmissionInput> = {}): AdmissionInput {
  return {
    operation: "create", scheduleId: "sched_fixture", name: "requested",
    selection: first, configured: ["anthropic", "openrouter"],
    models: { anthropic: ["model-a"], openrouter: ["model-b"] }, ...overrides,
  };
}
function record(pair: Pair): Schedule {
  return { scheduleId: "sched_fixture", name: "requested", modelSelection: pair };
}
function expected(
  journal: Event[], allowed = false, records: Schedule[] = [], returned?: Schedule,
): AdmissionObservation { return { allowed, records, returned, journal }; }
function validEvents(pair: Pair, operation: "create" | "update"): Event[] {
  return [
    ...(operation === "update" ? [["store.get", "sched_fixture"]] : []),
    ["selection.check", pair], ["settings.read", pair.providerId],
    ["catalog.read", pair.providerId], ["store." + operation, record(pair)],
    ["event.publish", operation === "create" ? "schedule.created" : "schedule.updated", "sched_fixture"],
  ];
}
const rejectedUpdatePrefix: Event[] = [["store.get", "sched_fixture"]];
export const admissionScenarios: readonly Scenario[] = [
  { id: "create-direct-pair", input: input(),
    expected: expected(validEvents(first, "create"), true, [record(first)], record(first)) },
  { id: "update-replaces-complete-pair", input: input({ operation: "update", initial, selection: second }),
    expected: expected(validEvents(second, "update"), true, [record(second)], record(second)) },
  { id: "metadata-update-preserves-pair", input: input({ operation: "update", initial, selection: undefined }),
    expected: expected(validEvents(first, "update"), true, [record(first)], record(first)) },
  { id: "create-second-direct-provider", input: input({ selection: second }),
    expected: expected(validEvents(second, "create"), true, [record(second)], record(second)) },
  ...(["cline", "cline-pass", "cline-cloud", "CLINE"] as const).map(providerId => ({
    id: "reject-forbidden-" + providerId,
    input: input({ selection: { providerId, modelId: "model-a" } }),
    expected: expected([["selection.check", { providerId, modelId: "model-a" }]]),
  })),
  { id: "reject-missing-create-pair", input: input({ selection: undefined }),
    expected: expected([["selection.check", null]]) },
  { id: "reject-provider-only-update", input: input({ operation: "update", initial, selection: { providerId: "openrouter" } }),
    expected: expected([...rejectedUpdatePrefix, ["selection.check", { providerId: "openrouter" }]], false, [initial]) },
  { id: "reject-model-only-update", input: input({ operation: "update", initial, selection: { modelId: "model-b" } }),
    expected: expected([...rejectedUpdatePrefix, ["selection.check", { modelId: "model-b" }]], false, [initial]) },
  { id: "reject-stale-catalog-model", input: input({ operation: "update", initial, selection: { providerId: "openrouter", modelId: "missing-model" } }),
    expected: expected([...rejectedUpdatePrefix, ["selection.check", { providerId: "openrouter", modelId: "missing-model" }],
      ["settings.read", "openrouter"], ["catalog.read", "openrouter"]], false, [initial]) },
  { id: "reject-unconfigured-provider", input: input({ selection: second, configured: ["anthropic"] }),
    expected: expected([["selection.check", second], ["settings.read", "openrouter"]]) },
  { id: "reject-empty-provider", input: input({ selection: { providerId: "   ", modelId: "model-a" } }),
    expected: expected([["selection.check", { providerId: "   ", modelId: "model-a" }]]) },
  { id: "reject-empty-model", input: input({ selection: { providerId: "anthropic", modelId: "" } }),
    expected: expected([["selection.check", { providerId: "anthropic", modelId: "" }]]) },
  ...(["failed", "empty", "disabled"] as const).map(catalogState => ({
    id: "reject-catalog-" + catalogState,
    input: input({ operation: "update", initial, catalogState, selection: second }),
    expected: expected([...rejectedUpdatePrefix, ["selection.check", second],
      ["settings.read", "openrouter"], ["catalog.read", "openrouter"],
      ["catalog." + catalogState, "openrouter"]], false, [initial]),
  })),
  { id: "delayed-catalog-does-not-write-before-response",
    input: input({ operation: "update", initial, catalogState: "delayed", selection: second }),
    expected: { ...expected([["store.get", "sched_fixture"], ["selection.check", second],
      ["settings.read", "openrouter"], ["catalog.read", "openrouter"],
      ["catalog.pending", "openrouter"], ["catalog.resolved", "openrouter"],
      ["store.update", record(second)], ["event.publish", "schedule.updated", "sched_fixture"]],
      true, [record(second)], record(second)),
      pending: { records: [initial], journal: [["store.get", "sched_fixture"],
        ["selection.check", second], ["settings.read", "openrouter"],
        ["catalog.read", "openrouter"], ["catalog.pending", "openrouter"]] } },
  },
  { id: "reject-legacy-cloud-preserved-selection", input: input({ operation: "update",
      initial: { ...initial, modelSelection: { providerId: "cline", modelId: "cloud-default" } }, selection: undefined }),
    expected: expected([...rejectedUpdatePrefix, ["selection.check", { providerId: "cline", modelId: "cloud-default" }]],
      false, [{ ...initial, modelSelection: { providerId: "cline", modelId: "cloud-default" } }]) },
];
export function assertAdmissionScenario(scenario: Scenario, observed: AdmissionObservation): void {
  deepStrictEqual(observed.journal, scenario.expected.journal, "complete ordered reads/admission/write/publication");
  strictEqual(observed.allowed, scenario.expected.allowed, "admission outcome");
  deepStrictEqual(observed.records, scenario.expected.records, "whole persisted pair and no rejected mutation");
  deepStrictEqual(observed.returned, scenario.expected.returned, "exact returned pair without substitution");
  deepStrictEqual(observed.pending, scenario.expected.pending, "actual state/effects while catalog pending");
}
export const admissionControls: readonly { scenario: string; fault: AdmissionFault }[] = [
  ...["create-direct-pair", "update-replaces-complete-pair", "metadata-update-preserves-pair"].flatMap(scenario =>
    (["always-reject", "validate-after-write", "skip-settings", "skip-catalog",
      "cloud-fallback", "partial-write", "wrong-provider", "wrong-model", "omit-write",
      "extra-write", "publish-before-write", "omit-publication", "wrong-returned-pair",
      "mutate-before-validation"] as const)
      .filter(fault => fault !== "partial-write" || scenario !== "metadata-update-preserves-pair")
      .map(fault => ({ scenario, fault }))),
  ...admissionScenarios.filter(row => !row.expected.allowed).flatMap(row =>
    (["always-allow", "validate-after-write", "write-rejected", "mutate-before-validation"] as const)
      .map(fault => ({ scenario: row.id, fault }))),
  ...(["failed", "empty", "disabled"] as const).map(kind => ({
    scenario: "reject-catalog-" + kind, fault: "skip-catalog" as const,
  })),
  { scenario: "reject-catalog-failed", fault: "ignore-catalog-error" },
  ...(["write-during-pending", "omit-write", "publish-before-write", "skip-catalog",
    "always-allow", "omit-publication"] as const).map(fault => ({
      scenario: "delayed-catalog-does-not-write-before-response", fault,
    })),
  { scenario: "reject-stale-catalog-model", fault: "wrong-catalog-response" },
  { scenario: "reject-unconfigured-provider", fault: "wrong-settings-response" },
];

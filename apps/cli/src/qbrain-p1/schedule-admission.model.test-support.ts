// Test-only independent host admission model. No production imports or expected objects.
export type Pair = { providerId: string; modelId: string };
export type Operation = "create" | "import" | "update" | "resume" | "trigger" | "open" | "cancel";
export type RecordInput = Record<string, unknown>;
export interface AdmissionInput {
  host: "cli" | "hub";
  operation: Operation;
  selection?: RecordInput;
  stored?: RecordInput;
  remembered?: { explicit: boolean; pair: Pair };
}
export interface Catalog {
  providerId: string;
  enabled: boolean;
  models: string[];
}
export interface Script {
  catalogs: Catalog[];
  error?: string;
  delayed?: boolean;
}
export type Fault =
  | "none" | "scalar-borrow" | "partial-borrow" | "first-model"
  | "allow-hosted" | "ignore-enabled" | "cross-catalog" | "swallow-error"
  | "write-before-catalog" | "write-while-pending" | "omit-write" | "double-write"
  | "wrong-pair" | "wrong-result" | "false-unchanged" | "activate-on-open"
  | "omit-catalog" | "reorder-response" | "accept-malformed-catalog";
export interface Event { kind: string; data?: unknown }
export interface Outcome { ok: boolean; pair?: Pair; error?: string; unchanged?: boolean }
export interface AdmissionRun {
  result: Promise<Outcome>;
  settle(): void;
  journal: Event[];
  snapshot(): RecordInput | undefined;
}
export type Factory = (input: AdmissionInput, script: Script, fault?: Fault) => AdmissionRun;
const copy = <T>(value: T): T => structuredClone(value);
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;
const cloud = (id: string): boolean =>
  ["cline", "cline-pass", "cline-cloud"].includes(id.trim().toLowerCase());
class AdmissionError extends Error {}
function pairFromRecord(record: RecordInput, fault: Fault): Pair {
  const structuredPresent = Object.prototype.hasOwnProperty.call(record, "modelSelection");
  const structured = record.modelSelection;
  let provider: unknown;
  let model: unknown;
  if (structuredPresent) {
    if (!structured || typeof structured !== "object" || Array.isArray(structured)) {
      if (fault !== "scalar-borrow") throw new AdmissionError("Repair modelSelection as a complete provider/model pair.");
    }
    const members = structured && typeof structured === "object" && !Array.isArray(structured)
      ? structured as RecordInput : {};
    provider = members.providerId;
    model = members.modelId;
    if (fault === "scalar-borrow") {
      if (!text(provider)) provider = record.providerId ?? record.provider;
      if (!text(model)) model = record.modelId ?? record.model;
    }
  } else {
    provider = record.providerId ?? record.provider;
    model = record.modelId ?? record.model;
  }
  const providerId = text(provider);
  const modelId = text(model);
  if (!providerId || !modelId) throw new AdmissionError("Select both provider and model explicitly in Settings.");
  return { providerId, modelId };
}
export const independentHostModel: Factory = (original, originalScript, fault = "none") => {
  // Own copies prevent accidental expected-data or caller-state aliasing.
  const input = copy(original);
  const script = copy(originalScript);
  const journal: Event[] = [];
  let stored = copy(input.stored);
  let release: (() => void) | undefined;
  const pending = script.delayed ? new Promise<void>((resolve) => { release = resolve; }) : undefined;
  const emit = (kind: string, data?: unknown) => journal.push(data === undefined ? { kind } : { kind, data: copy(data) });
  const write = (pair: Pair) => {
    const actual = fault === "wrong-pair" ? { providerId: "other-direct", modelId: pair.modelId } : pair;
    // Observe the submitted command and apply its own synthetic store semantics.
    if (input.operation === "resume") stored = { ...(stored ?? {}), enabled: true };
    else if (input.operation !== "trigger") stored = { ...(stored ?? {}), modelSelection: copy(actual) };
    emit("command", { operation: input.operation, pair: actual });
  };
  const run = async (): Promise<Outcome> => {
    emit("input", { host: input.host, operation: input.operation });
    if (input.stored !== undefined) emit("read", input.stored);
    if (input.operation === "open" || input.operation === "cancel") {
      if (fault === "activate-on-open") emit("activate", input.stored);
      if (fault === "false-unchanged") {
        stored = { ...(stored ?? {}), modelSelection: { providerId: "other-direct", modelId: "changed" } };
      }
      let error: string | undefined;
      try {
        const pair = pairFromRecord(input.stored ?? {}, fault);
        if (cloud(pair.providerId)) error = "Select a direct provider and model before saving this legacy schedule.";
      } catch (cause) { error = (cause as Error).message; }
      const outcome: Outcome = { ok: true, unchanged: true, ...(error ? { error } : {}) };
      emit("result", outcome);
      return outcome;
    }
    try {
      let selection = input.selection;
      if (selection === undefined) {
        if (["update", "resume", "trigger"].includes(input.operation) && input.stored) selection = input.stored;
        else if (input.remembered?.explicit) selection = { modelSelection: input.remembered.pair };
        else throw new AdmissionError("Select both provider and model explicitly in Settings.");
      }
      if (fault === "partial-borrow" && input.remembered) {
        selection = {
          provider: selection.provider ?? input.remembered.pair.providerId,
          model: selection.model ?? input.remembered.pair.modelId,
        };
      }
      let pair: Pair;
      if (fault === "first-model" && !text(selection.model) && script.catalogs[0]?.models[0]) {
        pair = { providerId: text(selection.provider) ?? script.catalogs[0].providerId, modelId: script.catalogs[0].models[0] };
      } else pair = pairFromRecord(selection, fault);
      emit("selection", pair);
      if (cloud(pair.providerId) && fault !== "allow-hosted") {
        throw new AdmissionError("Select a permitted direct provider and model; hosted Cline routes are unavailable.");
      }
      if (fault === "write-before-catalog") write(pair);
      if (fault !== "omit-catalog") emit("catalog-request", { providerId: pair.providerId });
      if (fault === "reorder-response") emit("catalog-response", script.catalogs);
      if (pending) {
        if (fault === "write-while-pending") write(pair);
        await pending;
      }
      if (script.error && fault !== "swallow-error") {
        emit("catalog-error", script.error);
        throw new AdmissionError("Catalog unavailable. Open Settings and retry: " + script.error);
      }
      if (fault !== "omit-catalog" && fault !== "reorder-response") emit("catalog-response", script.catalogs);
      const malformed = !Array.isArray(script.catalogs) || script.catalogs.some((entry) =>
        entry === null || typeof entry !== "object" || Array.isArray(entry)
        || typeof entry.providerId !== "string" || !entry.providerId.trim()
        || typeof entry.enabled !== "boolean" || !Array.isArray(entry.models)
        || entry.models.some((id) => typeof id !== "string" || !id.trim()));
      if (malformed && fault !== "accept-malformed-catalog") {
        throw new AdmissionError("Catalog response is malformed. Open Settings and retry.");
      }
      const effective = malformed ? [{ providerId: pair.providerId, enabled: true, models: [pair.modelId] }] : script.catalogs;
      const catalog = effective.find((entry) => entry.providerId === pair.providerId);
      const valid = fault === "cross-catalog"
        ? script.catalogs.some((entry) => entry.enabled && entry.models.includes(pair.modelId))
        : catalog && (catalog.enabled || fault === "ignore-enabled") && catalog.models.includes(pair.modelId);
      if (!valid) throw new AdmissionError("Selected provider/model is unavailable in its current enabled catalog. Open Settings.");
      if (fault !== "omit-write") write(pair);
      if (fault === "double-write") write(pair);
      if (input.operation === "resume" || input.operation === "trigger") emit("activate", { operation: input.operation, pair });
      const outcome: Outcome = { ok: true, pair: fault === "wrong-result" ? { ...pair, modelId: "changed-result" } : pair };
      emit("result", outcome);
      return outcome;
    } catch (cause) {
      if (!(cause instanceof AdmissionError)) throw cause;
      const outcome: Outcome = { ok: false, error: cause.message };
      emit("result", outcome);
      return outcome;
    }
  };
  return { result: run(), settle: () => release?.(), journal, snapshot: () => copy(stored) };
};

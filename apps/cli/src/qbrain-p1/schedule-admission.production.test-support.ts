// Leased execution only. Real private app functions, scripted catalog/store/command dependencies.
import {
  admitSchedulePair, inspectSchedulePair, readExplicitSchedulePair, ScheduleAdmissionError,
} from "../../../cline-hub/src/server/qbrain-schedule-admission";
import { independentHostModel, type AdmissionRun, type Event, type Factory, type Pair, type RecordInput } from "./schedule-admission.model.test-support";
import { runAdmissionContract } from "./schedule-admission.contract.test";

const clone = <T>(value: T): T => structuredClone(value);
export const realPrivateAdmissionFunctions: Factory = (original, originalScript, fault = "none") => {
  // Internal wrong-behavior mutants remain independently modeled assertion controls.
  // They are never reported as calls to the real production implementation.
  if (fault !== "none") return independentHostModel(original, originalScript, fault);
  const input = clone(original);
  const script = clone(originalScript);
  const journal: Event[] = [];
  let stored = clone(input.stored);
  let release: (() => void) | undefined;
  const pending = script.delayed ? new Promise<void>((resolve) => { release = resolve; }) : undefined;
  const emit = (kind: string, data?: unknown) => journal.push(data === undefined ? { kind } : { kind, data: clone(data) });
  const command = (pair: Pair) => {
    if (input.operation === "resume") stored = { ...(stored ?? {}), enabled: true };
    else if (input.operation !== "trigger") stored = { ...(stored ?? {}), modelSelection: clone(pair) };
    emit("command", { operation: input.operation, pair });
    if (input.operation === "resume" || input.operation === "trigger") emit("activate", { operation: input.operation, pair });
    return pair;
  };
  const run = async () => {
    emit("input", { host: input.host, operation: input.operation });
    if (input.stored !== undefined) emit("read", input.stored);
    if (input.operation === "open" || input.operation === "cancel") {
      const error = inspectSchedulePair(input.stored);
      const result = { ok: true, unchanged: true, ...(error ? { error } : {}) };
      emit("result", result);
      return result;
    }
    try {
      const raw = input.selection === undefined && ["update", "resume", "trigger"].includes(input.operation)
        ? input.stored : input.selection;
      const remembered = input.remembered?.explicit === true
        ? { explicit: true as const, pair: input.remembered.pair } : undefined;
      const selected = readExplicitSchedulePair(raw, remembered);
      emit("selection", selected);
      const admitted = await admitSchedulePair(raw, async (providerId) => {
        emit("catalog-request", { providerId });
        if (pending) await pending;
        if (script.error) {
          emit("catalog-error", script.error);
          throw new Error(script.error);
        }
        emit("catalog-response", script.catalogs);
        return script.catalogs;
      }, remembered);
      const result = { ok: true, pair: command(admitted) };
      emit("result", result);
      return result;
    } catch (error) {
      if (!(error instanceof ScheduleAdmissionError)) throw error;
      const result = { ok: false, error: error.message };
      emit("result", result);
      return result;
    }
  };
  const result: AdmissionRun = { result: run(), settle: () => release?.(), journal, snapshot: (): RecordInput | undefined => clone(stored) };
  return result;
};
if (import.meta.main) {
  runAdmissionContract(realPrivateAdmissionFunctions).then(
    (proof) => {
      const realDependencyControls = proof.evidence.filter((entry) => {
        const item = entry as { kind: string; control?: string };
        return item.kind === "rejecting-control" && item.control?.startsWith("dependency-");
      }).length;
      process.stdout.write(JSON.stringify({
        ...proof,
        evidenceKind: "actual isolated private app admission functions with scripted catalog and command/store effects",
        actualFunctionHistories: proof.scenarios,
        actualWrongDependencyResponseControls: realDependencyControls,
        independentModelMutationControls: proof.rejectingControls - realDependencyControls,
        actualPrivateFunctionBound: true,
        actualCliCommandBound: false,
        actualHubRoutineBound: false,
        actualGovernedHost: false,
        productionBound: false,
        productComplete: false,
      }));
    },
    (error) => { console.error(error); process.exitCode = 1; },
  );
}

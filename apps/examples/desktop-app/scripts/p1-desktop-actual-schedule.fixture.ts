// SPDX-License-Identifier: Apache-2.0
// Test-only synthetic Hub dependency. It never receives a Scenario or expected result.
import assert from "node:assert/strict";
import { AssertionError } from "node:assert";
import type { Operation, Pair } from "./p1-desktop-admission.contract.fixture";

type RecordValue = Record<string, unknown>;
export type TraceRow = { order: number; channel: string; operation: string; value: unknown };
export type HubDefect = "none" | "drop-write" | "wrong-pair" | "wrong-workspace" | "missing-read" | "read-before-write";
export class SyntheticScheduleHub {
  readonly trace: TraceRow[] = [];
  private readonly schedules = new Map<string, RecordValue>();
  private sequence = 0;
  private revision = 0;
  private writeAttempted = false;
  constructor(readonly workspaceRoot: string, private readonly defect: HubDefect = "none") {}
  record(channel: string, operation: string, value: unknown): void {
    this.trace.push({ order: ++this.sequence, channel, operation, value: structuredClone(value) });
  }
  seed(record: RecordValue): void {
    assert.equal(this.schedules.size, 0, "seed only before this task-owned scenario");
    assert.equal(typeof record.scheduleId, "string");
    this.schedules.set(record.scheduleId as string, structuredClone(record));
    this.record("hub", "seed", record);
  }
  snapshot(): RecordValue[] { return structuredClone([...this.schedules.values()]); }
  command = async (command: string, payload: RecordValue = {}) => {
    this.record("hub-request", command, payload);
    let body: RecordValue;
    if (command === "schedule.create" || command === "schedule.update") {
      this.writeAttempted = true;
      const scheduleId = command === "schedule.update" ? String(payload.scheduleId) : "synthetic-" + (++this.revision);
      if (command === "schedule.update" && !this.schedules.has(scheduleId)) throw new Error("Synthetic schedule missing");
      const before = this.schedules.get(scheduleId) ?? {};
      const stored: RecordValue = { ...before, ...structuredClone(payload), scheduleId,
        createdAt: before.createdAt ?? 1, updatedAt: ++this.revision };
      // These defects alter the dependency's actual storage effects, not the assertion result.
      if (this.defect === "wrong-pair") stored.modelSelection = { providerId: "unrequested-provider", modelId: "unrequested-model" };
      if (this.defect === "wrong-workspace") stored.workspaceRoot = "/synthetic-other-context";
      if (this.defect === "read-before-write") this.record("hub-storage", command, this.snapshot());
      if (this.defect !== "drop-write") {
        this.schedules.set(scheduleId, stored);
        this.record("hub-mutation", command, this.snapshot());
      }
      if (this.defect !== "read-before-write") this.record("hub-storage", command, this.snapshot());
      body = { schedule: structuredClone(stored) };
    } else if (command === "schedule.list") {
      body = { schedules: this.defect === "missing-read" && this.writeAttempted ? [] : this.snapshot() };
    } else if (command === "schedule.active" || command === "schedule.list_executions") body = { executions: [] };
    else if (command === "schedule.upcoming") body = { runs: [] };
    else throw new Error("Unexpected synthetic Hub command: " + command);
    const reply = { ok: true, payload: body };
    this.record("hub-response", command, reply);
    return reply;
  };
}

export type DesktopCommand = (command: string, args?: RecordValue) => Promise<unknown>;
export type StoredScheduleObservation = {
  kind: Operation["kind"]; pair: Pair; context: string; scheduleId: string; raw: RecordValue;
};

/** Calls the injected REAL desktop command consumer, then independently lists storage.
 * The caller must bind handleCommand from sidecar/commands.ts, not an echo provider.
 * No submitted provider/model or response-echo schedule can become an observation.
 */
export async function observeStoredSchedule(
  invokeActual: DesktopCommand,
  hub: SyntheticScheduleHub,
  command: "create_routine_schedule" | "update_routine_schedule",
  args: RecordValue,
  contextIdentity: { workspaceRoot: string; id: string },
): Promise<StoredScheduleObservation> {
  hub.record("desktop-request", command, args);
  const start = hub.trace.length;
  const response = await invokeActual(command, structuredClone(args));
  hub.record("desktop-response", command, response);
  const mutations = hub.trace.slice(start).filter((row) =>
    row.channel === "hub-storage" && (row.operation === "schedule.create" || row.operation === "schedule.update"));
  assert.equal(mutations.length, 1, "actual desktop consumer must cause one Hub storage effect");
  const actualMutations = hub.trace.slice(start).filter((row) => row.channel === "hub-mutation");
  assert.equal(actualMutations.length, 1, "actual desktop consumer must cause one independent Hub mutation");
  assert.ok(actualMutations[0]!.order < mutations[0]!.order, "storage callback precedes actual mutation");
  const storedAtWrite = (mutations[0]!.value as RecordValue[]).find((record) =>
    record.scheduleId === (command === "update_routine_schedule" ? args.schedule_id : (response as { schedule?: RecordValue })?.schedule?.scheduleId));
  assert.ok(storedAtWrite, "acknowledgement without persisted storage is not a commit");
  const read = await invokeActual("list_routine_schedules", {});
  hub.record("desktop-readback", "list_routine_schedules", read);
  const records = (read as { schedules?: RecordValue[] })?.schedules;
  assert.ok(Array.isArray(records), "actual command readback must return a schedule collection");
  const stored = records.find((record) => record.scheduleId === storedAtWrite.scheduleId);
  assert.ok(stored, "missing independent readback is not a commit");
  assert.deepEqual(stored, storedAtWrite, "storage changed between write and readback");
  assert.equal(stored.workspaceRoot, contextIdentity.workspaceRoot, "store belongs to another context");
  const selection = stored.modelSelection as RecordValue | undefined;
  assert.ok(selection && typeof selection.providerId === "string" && typeof selection.modelId === "string",
    "stored schedule must retain an atomic explicit modelSelection");
  // Read both members only from independent storage, never args or the write response.
  return { kind: command === "create_routine_schedule" ? "create" : "edit",
    pair: { providerId: selection.providerId, modelId: selection.modelId },
    context: contextIdentity.id, scheduleId: String(stored.scheduleId), raw: structuredClone(stored) };
}

export type ScheduleControlEvidence = { trace: TraceRow[]; finalStorage: RecordValue[] };
/** Assertion-owned control classifier. Never called by the provider, command consumer or synthetic Hub.
 * Expected effects belong to the frozen harness. A generic/unrelated exception cannot validate a control.
 */
export function assertIntendedScheduleRejection(
  error: unknown,
  control: { kind: "create" | "edit"; defect: HubDefect | "acknowledgement-only";
    evidence: ScheduleControlEvidence; observed?: { effects: unknown[]; stored: Pair | null }; expectedEffects: unknown[] },
): void {
  assert.ok(error instanceof AssertionError, "control rejected: unrelated non-assertion exception");
  assert.equal(error.code, "ERR_ASSERTION", "control rejected: not a Node assertion");
  const { kind, defect, evidence } = control;
  const write = kind === "create" ? "schedule.create" : "schedule.update";
  const rows = (channel: string, operation = write) => evidence.trace.filter((row) => row.channel === channel && row.operation === operation);
  const requests = rows("hub-request"); const mutations = rows("hub-mutation");
  const callbacks = rows("hub-storage"); const responses = rows("hub-response");
  const desktopResponses = evidence.trace.filter((row) => row.channel === "desktop-response");
  assert.equal(desktopResponses.length, 1, "control rejected: actual desktop response was not exercised");
  if (defect === "acknowledgement-only") {
    assert.equal(error.operator, "strictEqual");
    assert.ok(error.message.startsWith("actual desktop consumer must cause one Hub storage effect"));
    assert.equal(error.actual, 0); assert.equal(error.expected, 1);
    assert.equal(requests.length, 0); assert.equal(callbacks.length, 0); assert.equal(mutations.length, 0);
    assert.equal((desktopResponses[0]!.value as { schedule: RecordValue }).schedule.scheduleId, "echo-only");
    assert.equal(evidence.finalStorage.length, kind === "edit" ? 1 : 0);
    return;
  }
  assert.equal(requests.length, 1); assert.equal(callbacks.length, 1); assert.equal(responses.length, 1);
  if (defect === "drop-write") {
    assert.equal(error.operator, "strictEqual");
    assert.ok(error.message.startsWith("actual desktop consumer must cause one independent Hub mutation"));
    assert.equal(error.actual, 0); assert.equal(error.expected, 1); assert.equal(mutations.length, 0);
    assert.deepEqual(callbacks[0]!.value, evidence.finalStorage);
    assert.equal(evidence.finalStorage.length, kind === "edit" ? 1 : 0);
    if (kind === "edit") assert.deepEqual(evidence.finalStorage, [evidence.trace.find((row) => row.channel === "hub" && row.operation === "seed")!.value]);
    const acknowledged = (responses[0]!.value as { payload: { schedule: RecordValue } }).payload.schedule;
    assert.equal(acknowledged.name, (requests[0]!.value as RecordValue).name);
    assert.notDeepEqual(evidence.finalStorage, [acknowledged]);
    return;
  }
  assert.equal(mutations.length, 1);
  if (defect === "read-before-write") {
    assert.equal(error.operator, "==");
    assert.ok(error.message.startsWith("storage callback precedes actual mutation"));
    assert.equal(error.actual, false); assert.equal(error.expected, true);
    assert.ok(callbacks[0]!.order < mutations[0]!.order);
    const callbackState = callbacks[0]!.value as RecordValue[];
    assert.equal(callbackState.length, kind === "edit" ? 1 : 0);
    if (kind === "edit") assert.deepEqual(callbackState, [evidence.trace.find((row) => row.channel === "hub" && row.operation === "seed")!.value]);
    assert.equal(evidence.finalStorage.length, 1);
    assert.deepEqual(evidence.finalStorage, mutations[0]!.value);
    assert.equal(evidence.finalStorage[0]!.name, (requests[0]!.value as RecordValue).name);
    assert.notDeepEqual(callbackState, evidence.finalStorage);
    return;
  }
  assert.ok(mutations[0]!.order < callbacks[0]!.order);
  assert.deepEqual(mutations[0]!.value, evidence.finalStorage);
  if (defect === "missing-read") {
    assert.equal(error.operator, "==");
    assert.ok(error.message.startsWith("missing independent readback is not a commit"));
    const reads = evidence.trace.filter((row) => row.channel === "hub-response" && row.operation === "schedule.list");
    assert.equal(reads.length, 1);
    assert.deepEqual((reads[0]!.value as { payload: RecordValue }).payload.schedules, []);
    assert.equal(evidence.finalStorage.length, 1);
    return;
  }
  if (defect === "wrong-workspace") {
    assert.equal(error.operator, "strictEqual");
    assert.ok(error.message.startsWith("store belongs to another context"));
    assert.equal(error.actual, "/synthetic-other-context");
    assert.equal(error.expected, (requests[0]!.value as RecordValue).workspaceRoot);
    assert.equal(evidence.finalStorage[0]!.workspaceRoot, error.actual);
    return;
  }
  assert.equal(defect, "wrong-pair");
  assert.equal(error.operator, "deepStrictEqual", "wrong pair must reach SAME frozen effects assertion");
  assert.ok(control.observed, "wrong pair must have a completed actual observation");
  assert.deepEqual(error.actual, control.observed.effects);
  assert.deepEqual(error.expected, control.expectedEffects);
  assert.deepEqual(control.observed.stored, { providerId: "unrequested-provider", modelId: "unrequested-model" });
  assert.deepEqual(evidence.finalStorage[0]!.modelSelection, control.observed.stored);
}


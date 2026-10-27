// SPDX-License-Identifier: Apache-2.0
// First-party P1 test entry. No production import, child process, network or real signal.
import { strict as assert, AssertionError } from "node:assert";
import { assertBinSignal, classifierGuards, cloneInput, qualifiesRejection, scriptedResponses, signalControls } from "./bin-signal.contract";
import type { SignalObservation } from "./bin-signal.contract";
import { observeBinSignal } from "./bin-signal.model";

function pack(value: unknown): unknown {
  if (value === undefined) return { type: "undefined" };
  if (value instanceof Error) {
    const extra = value as Error & { code?: string; operator?: string; actual?: unknown; expected?: unknown };
    return { type: value.name, message: value.message, stack: value.stack, code: extra.code, operator: extra.operator, actual: pack(extra.actual), expected: pack(extra.expected), ownProperties: Object.fromEntries(Object.getOwnPropertyNames(value).map((key) => [key, pack((value as unknown as Record<string, unknown>)[key])])) };
  }
  if (Array.isArray(value)) return value.map(pack);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, pack(entry)]));
  }
  return value;
}
function emit(value: unknown): void {
  console.log(JSON.stringify(pack(value)));
}
let correct = 0;
let rejected = 0;
let guards = 0;
let histories = 0;
let failed = 0;
const failures: unknown[] = [];

try {
  const input = cloneInput();
  const script = scriptedResponses();
  const observed = observeBinSignal(input, script);
  histories++;
  try {
    assertBinSignal(observed, input);
    correct++;
    emit({ kind: "correct", input, script, observed, accepted: true });
  } catch (error) {
    failed++;
    failures.push(error);
    emit({ kind: "correct", input, script, observed, accepted: false, error });
  }
} catch (error) {
  failed++;
  failures.push(error);
  emit({ kind: "harness-failure", stage: "correct", error });
}
for (const control of signalControls) {
  const input = cloneInput();
  const script = scriptedResponses(control.patch);
  let observed: SignalObservation | undefined;
  try {
    observed = observeBinSignal(input, script);
    histories++;
  } catch (error) {
    failed++;
    failures.push(error);
    emit({ kind: "harness-failure", control: control.id, input, script, error });
    continue;
  }
  let caught: unknown;
  try {
    assertBinSignal(observed, input);
  } catch (error) {
    caught = error;
  }
  const qualified = qualifiesRejection(caught, control.intendedAssertion, control.operator, observed);
  if (!qualified) {
    failed++;
    failures.push(caught ?? new Error("Incorrect interaction was accepted"));
    emit({ kind: "control", control, input, script, observed, qualified: false, error: caught });
    continue;
  }
  try {
    assert.ok(caught instanceof AssertionError, "qualified error class");
    const checked = classifierGuards(caught, control, observed);
    guards += checked.length;
    rejected++;
    emit({ kind: "control", control, input, script, observed, qualified: true, error: caught, classifierGuards: checked });
  } catch (error) {
    failed++;
    failures.push(error);
    emit({ kind: "classifier-failure", control, input, script, observed, originalError: caught, error });
  }
}
try {
  assert.equal(correct, 1, "denominator.correct");
  assert.equal(rejected, 11, "denominator.rejects");
  assert.equal(guards, 55, "denominator.guards");
  assert.equal(histories, 12, "denominator.histories");
} catch (error) {
  failed++;
  failures.push(error);
  emit({ kind: "denominator-failure", error });
}
emit({ kind: "summary", correct, rejected, classifierGuards: guards, histories, failed, skipped: 0, failures, evidenceLevel: "independent-input-only-model", nativePOSIX: false, scopeAccepted: false });
if (failed) process.exitCode = 1;


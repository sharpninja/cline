// SPDX-License-Identifier: Apache-2.0
// Test-only observation of the existing rejecting updater guard. Does not permit a call.
import { createSynchronousTrace, type TraceEvent } from "../logging/sync-trace.test-support";
export function createUpdaterGuardTrace(emit: (entry: {event: TraceEvent; stack: string}) => void) {
  return createSynchronousTrace(event => emit({event,stack:new Error("C updater guard callsite").stack ?? ""}));
}

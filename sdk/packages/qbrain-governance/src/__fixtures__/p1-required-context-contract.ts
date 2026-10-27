// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import type { Observation } from "./p1-required-context-model";
/** SAME contract for independent mocks and the future accepted existing-seam adapter. */
export function assertRequiredContext(actual: Observation, expected: Observation): void {
  for (const key of ["providerRequests", "decisions", "interactions", "unrelatedSkillExecutions", "providerToolExecutions"] as const)
    assert.deepStrictEqual(actual[key], expected[key], "REQUIRED_CONTEXT:" + key);
}

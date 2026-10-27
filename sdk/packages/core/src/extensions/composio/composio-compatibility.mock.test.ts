// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./composio-tools-extension", () => import("./composio-compatibility.model.fixture"));
import { registeredCompatibilityCases } from "./composio-compatibility.cases";
import { parityScript } from "./composio-compatibility.model.fixture";

beforeEach(() => { parityScript.fault = undefined; parityScript.effects = []; });
const controls = [
  ["does not register another account's saved tools", "state-owner-rebound"],
  ["rejects a running session's tools after switching accounts", "request-on-account-change"],
  ["returns undefined when there is no connector state", "invent-state"],
  ["returns undefined when every connected toolkit has zero tools", "invent-empty-tools"],
  ["does not register saved tools without beta access", "ignore-bootstrap-beta"],
  ["refuses execution when beta access is removed after registration", "request-on-beta-revocation"],
  ["registers one snake_case tool per stored schema", "extra-registration"],
  ["skips a tool whose stored schema createTool rejects instead of failing setup", "drop-valid-registration"],
  ["executes tools through the Cline connectors proxy with a Bearer token and pinned version", "omit-version"],
  ["executes tools through the Cline connectors proxy with a Bearer token and pinned version", "wrong-auth"],
  ["executes tools through the Cline connectors proxy with a Bearer token and pinned version", "wrong-result"],
  ["returns a structured auth error when there is no signed-in account", "request-without-auth"],
  ...[401, 403, 502].map(status => ["returns structured errors on HTTP " + status + " instead of throwing", "ignore-http-error"]),
  ["returns structured errors when the network is unreachable", "lose-network-diagnostic"],
] as const;

function assertionConstructor(): Function {
  try { expect(0).toBe(1); }
  catch (error) {
    if (!(error instanceof Error) || error.name !== "AssertionError") throw error;
    return error.constructor;
  }
  throw new Error("reference assertion did not reject");
}
describe("Original assertions reject intentionally wrong compatibility interactions", () => {
  it("qualifies the reference assertion class and original fourteen-case registration", () => {
    expect(assertionConstructor().name).toBe("AssertionError");
    expect(registeredCompatibilityCases).toHaveLength(14);
  });
  for (const [name, fault] of controls) {
    it("rejects " + fault + " through " + name, async () => {
      const original = registeredCompatibilityCases.find(row => row.name === name);
      if (!original) throw new Error("original case not registered");
      parityScript.fault = fault;
      const expectedClass = assertionConstructor();
      let rejected = false;
      try { await original.body(); }
      catch (error) {
        if (!(error instanceof Error) || error.constructor !== expectedClass) throw error;
        rejected = true;
      }
      expect(rejected, "Only the original intended assertion rejection qualifies").toBe(true);
      console.log(JSON.stringify({ case: name, fault, assertionRejected: rejected, effects: parityScript.effects }));
    });
  }
});

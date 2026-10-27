// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./cline-account-feature-flags", () => import("./cline-account-flags.model.fixture"));
import { registeredFlagCases } from "./cline-account-flags.compatibility.cases";
import { flagScript } from "./cline-account-flags.model.fixture";
afterEach(() => { flagScript.fault = undefined; });
beforeEach(() => { flagScript.effects = []; });
const controls = [
  ...["false", "undefined", "true", "beta", "1"].map(value => ["denies " + value + " even for an internal email", "always-allow"]),
  ["denies true even for an internal email", "truthy-grant"],
  ["requires the actual flag, not a truthy payload", "payload-as-flag"],
  ...["duplicate-query", "wrong-root", "omit-dispose"].map(fault => ["evaluates by account ID and shares concurrent evaluations", fault]),
  ["denies signed-out accounts and missing provider configuration", "request-without-identity"],
  ["does not transfer grants to another account or across sign-out", "transfer-grant"],
  ["rejects an evaluation completed after the account changes", "ignore-account-change"],
  ["refreshes cached grants after one minute", "stale-cache"],
  ["fails closed on a provider failure and disposes its client", "failure-open"],
  ["fails closed on a provider failure and disposes its client", "omit-dispose"],
] as const;
function assertionConstructor(): Function {
  try { expect(0).toBe(1); }
  catch (error) {
    if (!(error instanceof Error) || error.name !== "AssertionError") throw error;
    return error.constructor;
  }
  throw new Error("reference assertion did not reject");
}
describe("Original generic flag assertions discriminate wrong identities/cache/provider effects", () => {
  it("qualifies assertion class and original twelve registrations", () => {
    expect(assertionConstructor().name).toBe("AssertionError");
    expect(registeredFlagCases).toHaveLength(12);
  });
  for (const [name, fault] of controls) {
    it("rejects " + fault + " through " + name, async () => {
      const original = registeredFlagCases.find(row => row.name === name);
      if (!original) throw new Error("original flag case missing");
      flagScript.fault = fault;
      const expectedClass = assertionConstructor();
      let rejected = false;
      try { await original.body(); }
      catch (error) {
        if (!(error instanceof Error) || error.constructor !== expectedClass) throw error;
        rejected = true;
      }
      expect(rejected, "Only the original assertion rejects the scripted wrong interaction").toBe(true);
      console.log(JSON.stringify({ case: name, fault, assertionRejected: rejected, effects: flagScript.effects }));
    });
  }
});

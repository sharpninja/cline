// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { AssertionError } from "node:assert";
import { auditBoundaryCases, runAuditBoundaryCase, assertAuditBoundaryCase } from "./p1-desktop-audit-boundary.contract.fixture";
import { createAuditBoundaryModel } from "./p1-desktop-audit-boundary.model.fixture";
for (const item of auditBoundaryCases) {
  test(item.name + " / correct independent capture model", async () => {
    const observed = await runAuditBoundaryCase(item, createAuditBoundaryModel());
    assertAuditBoundaryCase(item, observed);
    console.log(JSON.stringify({ scenario: item.name, mode: "AuditBoundaryMock", observed }));
  });
  for (const defect of item.rejects) {
    test(item.name + " / SAME assertion rejects interaction " + defect, async () => {
      assertAuditBoundaryCase(item, await runAuditBoundaryCase(item, createAuditBoundaryModel()));
      // Any provider exception fails the control. Only the SAME observation assertion is caught.
      const observed = await runAuditBoundaryCase(item, createAuditBoundaryModel(defect));
      let rejection: unknown;
      try { assertAuditBoundaryCase(item, observed); } catch (error) { rejection = error; }
      assert.ok(rejection instanceof AssertionError);
      assert.equal(rejection.code, "ERR_ASSERTION"); assert.equal(rejection.operator, "deepStrictEqual");
      assert.deepEqual(rejection.actual, observed); assert.deepEqual(rejection.expected, item.expected);
      console.log(JSON.stringify({ scenario: item.name, defect, rejected: true, rejection: String(rejection), observed }));
    });
  }
}
test("AC069 desktop boundary inventory preserves eight cases and twenty-three actual interaction controls", () => {
  expect(auditBoundaryCases).toHaveLength(8);
  expect(auditBoundaryCases.reduce((sum, item) => sum + item.rejects.length, 0)).toBe(23);
});

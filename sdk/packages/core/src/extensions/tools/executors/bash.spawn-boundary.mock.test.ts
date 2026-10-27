// SPDX-License-Identifier: Apache-2.0
import assert, { AssertionError } from "node:assert/strict";
import { describe, it } from "vitest";
import {
  args, assertBoundary, exerciseBoundary, scriptedProcess,
  type LaunchRequest,
} from "./bash.spawn-boundary.fixture";

const inputs: LaunchRequest[] = [
  { kind: "sync", executable: String.raw`\\?\C:\synthetic\PowerShell\pwsh.exe`, argv: args(), cwd: "C:/synthetic/work" },
  { kind: "async", executable: String.raw`\\?\C:\synthetic\PowerShell\pwsh.exe`, argv: args(), cwd: "C:/synthetic/work" },
  { kind: "sync", executable: "pwsh.exe", argv: args(), cwd: "C:/synthetic/work" },
  { kind: "sync", executable: "C:/synthetic/PowerShell/pwsh.exe", argv: args(), cwd: "C:/synthetic/work" },
  { kind: "async", executable: "pwsh.exe", argv: args(), cwd: "C:/synthetic/work" },
  { kind: "async", executable: "C:/synthetic/PowerShell/pwsh.exe", argv: args(), cwd: "C:/synthetic/work" },
];
describe("independent PowerShell Node boundary assertions", () => {
  for (const input of inputs) {
    const label = input.kind + " " + input.executable;
    it("accepts independently processed literal program: " + label, async () => {
      const fake = scriptedProcess();
      const observed = await exerciseBoundary(input, fake.launcher);
      assertBoundary(observed, input);
      assert.deepStrictEqual(fake.processed, [input]);
    });
    for (const mutation of ["omit", "duplicate", "executable", "arguments", "cwd"] as const) {
      it("rejects actual launch interaction " + mutation + ": " + label, async () => {
        const fake = scriptedProcess();
        const observed = await exerciseBoundary(input, fake.launcher, mutation);
        assert.throws(() => assertBoundary(observed, input), (error) => error instanceof AssertionError);
        assert.equal(fake.processed.length, mutation === "omit" ? 0 : mutation === "duplicate" ? 2 : 1);
      });
    }
    for (const response of ["error", "missing-output"] as const) {
      it("rejects independently scripted " + response + ": " + label, async () => {
        const fake = scriptedProcess(response);
        const observed = await exerciseBoundary(input, fake.launcher);
        assert.throws(() => assertBoundary(observed, input), (error) => error instanceof AssertionError);
        assert.deepStrictEqual(fake.processed, [input]);
      });
    }
  }
});

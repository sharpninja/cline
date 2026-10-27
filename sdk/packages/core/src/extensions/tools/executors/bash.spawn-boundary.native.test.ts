// SPDX-License-Identifier: Apache-2.0
// These four native probes diagnose the original matrix, not replace its cases.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "vitest";
import {
  args, assertBoundary, exerciseBoundary, nativeProcess,
  type LaunchRequest,
} from "./bash.spawn-boundary.fixture";

describe("actual Node PowerShell spawn boundary", () => {
  const bare = process.platform === "win32" ? "pwsh.exe" : "pwsh";
  // Original matrix's independent installed-shell discovery supplies an INPUT
  // executable path. No tested result/expected-output object is copied from it.
  const probe = spawnSync(bare, args("[Console]::Write((Get-Process -Id $PID).Path)"), {
    encoding: "utf8", windowsHide: true, timeout: 10_000,
  });
  const resolved = probe.status === 0 ? probe.stdout.trim() : "";
  for (const kind of ["sync", "async"] as const) {
    for (const [source, executable] of [["bare", bare], ["resolved", resolved], ["extended", process.platform === "win32" ? "\\\\?\\" + resolved : resolved]] as const) {
      it("preserves exact program under " + kind + " " + source, async () => {
        assert.equal(probe.status, 0, "original discovery prerequisite");
        assert.ok(executable, "discovered path must be present; no skipped case");
        const input: LaunchRequest = { kind, executable, argv: args(), cwd: process.cwd() };
        const observed = await exerciseBoundary(input, nativeProcess);
        console.info("NODE_SPAWN_BOUNDARY", JSON.stringify({
          node: process.execPath, version: process.version, input, observed,
        }));
        assertBoundary(observed, input);
      });
    }
  }
});

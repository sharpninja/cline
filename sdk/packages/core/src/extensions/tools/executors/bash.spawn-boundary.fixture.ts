// SPDX-License-Identifier: Apache-2.0
// Diagnostic for the original bash.powershell.test.ts spawn boundary.
// Test-only input model; no production resolver, policy or fallback is introduced.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";

export const boundaryScript = "[Console]::Write('node-spawn-boundary')";
export const requiredOutput = "node-spawn-boundary";
export interface LaunchRequest {
  kind: "sync" | "async";
  executable: string;
  argv: string[];
  cwd: string;
}
export interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  launchError: string | null;
}
export type Launcher = (request: LaunchRequest) => Promise<ProcessResult>;
export interface Observation extends ProcessResult { requests: LaunchRequest[] }
export const args = (script = boundaryScript) => [
  "-NoProfile", "-NonInteractive", "-Command", script,
];
export function assertBoundary(observation: Observation, input: LaunchRequest): void {
  assert.deepStrictEqual(observation.requests, [input], "exact single launch request");
  assert.equal(observation.launchError, null, "no launch error");
  assert.equal(observation.exitCode, 0, "successful child exit");
  assert.equal(observation.stdout, requiredOutput, "complete exact child stdout");
  assert.equal(observation.stderr, "", "no child stderr");
}
export async function exerciseBoundary(
  input: LaunchRequest, launcher: Launcher,
  mutation: "none" | "omit" | "duplicate" | "executable" | "arguments" | "cwd" = "none",
): Promise<Observation> {
  const requests: LaunchRequest[] = [];
  const invoke = async (request: LaunchRequest) => {
    const snapshot = structuredClone(request);
    requests.push(snapshot);
    return launcher(snapshot);
  };
  const actual = structuredClone(input);
  if (mutation === "executable") actual.executable = "wrong-shell";
  if (mutation === "arguments") actual.argv = args("[Console]::Write('wrong-program')");
  if (mutation === "cwd") actual.cwd += "/wrong-root";
  if (mutation === "omit")
    return { requests, exitCode: null, stdout: "", stderr: "", launchError: "not launched" };
  const result = await invoke(actual);
  if (mutation === "duplicate") await invoke(actual);
  return { ...result, requests };
}
// Independent fake owns processed-request state and evaluates only this fixture's
// literal Write instruction. It never receives input expectations or observations.
export function scriptedProcess(mode: "normal" | "error" | "missing-output" = "normal") {
  const processed: LaunchRequest[] = [];
  const launcher: Launcher = async (request) => {
    processed.push(structuredClone(request));
    if (mode === "error")
      return { exitCode: null, stdout: "", stderr: "", launchError: "EPERM" };
    const match = /^\[Console\]::Write\('([^']*)'\)$/.exec(request.argv.at(-1) ?? "");
    if (!match)
      return { exitCode: 1, stdout: "", stderr: "unsupported fixture instruction", launchError: null };
    return {
      exitCode: 0, stdout: mode === "missing-output" ? "" : match[1],
      stderr: "", launchError: null,
    };
  };
  return { launcher, processed };
}
export const nativeProcess: Launcher = async (request) => {
  if (request.kind === "sync") {
    const child = spawnSync(request.executable, request.argv, {
      cwd: request.cwd, env: process.env, encoding: "utf8", windowsHide: true,
      timeout: 10_000,
    });
    return {
      exitCode: child.status, stdout: child.stdout ?? "", stderr: child.stderr ?? "",
      launchError: child.error ? child.error.message : null,
    };
  }
  return new Promise<ProcessResult>((resolve) => {
    let stdout = "", stderr = "", settled = false;
    const finish = (exitCode: number | null, launchError: string | null) => {
      if (settled) return;
      settled = true;
      resolve({ exitCode, stdout, stderr, launchError });
    };
    try {
      const child = spawn(request.executable, request.argv, {
        cwd: request.cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      });
      child.stdin.end();
      child.stdout.setEncoding("utf8").on("data", (part) => { stdout += part; });
      child.stderr.setEncoding("utf8").on("data", (part) => { stderr += part; });
      child.once("error", (error) => finish(null, error.message));
      child.once("close", (code) => finish(code, null));
    } catch (error) {
      finish(null, error instanceof Error ? error.message : String(error));
    }
  });
};

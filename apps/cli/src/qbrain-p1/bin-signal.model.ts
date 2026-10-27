// SPDX-License-Identifier: Apache-2.0
// Independent input-only policy model. Type imports erase; no fixture or expected-result import.
import type { Effect, SignalInput, SignalObservation, SignalScript } from "./bin-signal.contract";

export function observeBinSignal(input: SignalInput, script: SignalScript): SignalObservation {
  const effects: Effect[] = [];
  const errors: Error[] = [];
  const root = { wrapperPid: input.wrapperPid, childPid: input.childPid, state: "running", signal: null as string | null, status: null as number | null };
  const terminated = { ownedTermination: Symbol("synthetic-wrapper-termination") };
  const spawnError = Object.assign(new Error("scripted spawnSync EAGAIN"), { code: "EAGAIN" });
  const killError = Object.assign(new Error("scripted kill ESRCH"), { code: "ESRCH" });
  const responseError = Object.assign(new Error("scripted spawnSync ENOENT"), { code: "ENOENT" });

  function deliverRootSignal(pid: number, signal: string): never {
    // Scripted receiver owns state and records each actual delivery before termination.
    for (let index = 0; index < script.signalDeliveries; index++) {
      effects.push({ kind: "root-signal", pid, signal, delivery: index });
      root.state = "signaled";
      root.signal = signal;
      root.status = null;
    }
    throw terminated;
  }
  function spawn(target: string, args: string[], options: { stdio: string; env: Record<string, string> }) {
    effects.push({ kind: "spawn", target, args: [...args], stdio: options.stdio, env: { ...options.env } });
    if (script.spawnBehavior === "throw-scripted-EAGAIN") throw spawnError;
    if (script.spawnBehavior === "terminate-root-before-spawn-return") {
      deliverRootSignal(input.wrapperPid, script.childCompletion.signal ?? "");
    }
    const response = {
      error: script.childCompletion.error ? responseError : undefined,
      status: script.childCompletion.status,
      signal: script.childCompletion.signal,
    };
    effects.push({ kind: "spawn-result", error: response.error, status: response.status, signal: response.signal });
    return response;
  }
  function exit(status: number): never {
    effects.push({ kind: "exit", status });
    root.state = "exited";
    root.status = status;
    root.signal = null;
    throw terminated;
  }
  function kill(pid: number, signal: string): void {
    effects.push({ kind: "kill", pid, signal });
    if (script.killBehavior === "throw-scripted-ESRCH") throw killError;
    if (pid !== input.wrapperPid) {
      // Synthetic receiver records a foreign target; it never touches a real process.
      effects.push({ kind: "foreign-signal", pid, signal });
      return;
    }
    if (script.killBehavior === "return-without-root-termination") return;
    deliverRootSignal(pid, signal);
  }

  // This is the OUTER wrapper launch response, not the child spawn response.
  // No wrapper policy body or child operation is entered when outer launch fails.
  if (script.outerWrapperLaunchError) {
    const launchError = Object.assign(new Error("scripted outer wrapper launch EACCES"), { code: "EACCES" });
    effects.push({ kind: "wrapper-launch-error", target: input.wrapper, error: launchError });
    root.state = "launch-failed";
    return {
      result: { error: launchError, status: null, signal: null },
      effects,
      wrapperBodyEntered: false,
      receiverState: { ...root },
      scriptedErrors: [launchError],
    };
  }

  try {
    const target = input.env.CLINE_BIN_PATH;
    if (!target) throw new Error("Input-only model requires explicit synthetic target");
    const child = spawn(target, input.argv.slice(2), { stdio: "inherit", env: { ...input.env, CLINE_WRAPPER_PATH: input.wrapper } });
    if (child.error) {
      effects.push({ kind: "console-error", error: child.error });
      errors.push(child.error);
      exit(1);
    }
    if (typeof child.status === "number") exit(child.status);
    if (child.signal) {
      kill(script.readPid, child.signal);
      exit(128);
    }
    exit(1);
  } catch (error) {
    if (error !== terminated) {
      if (error !== spawnError && error !== killError) throw error;
      errors.push(error);
      effects.push({ kind: "known-unhandled-script-error", error });
      root.state = "exited";
      root.status = 1;
      root.signal = null;
    }
  }
  return {
    result: { error: undefined, status: root.status, signal: root.signal },
    effects,
    wrapperBodyEntered: true,
    receiverState: { ...root },
    scriptedErrors: errors,
  };
}


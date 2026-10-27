// SPDX-License-Identifier: Apache-2.0
// Test-only input/dependency driven state machine. No production imports or expected objects.
import type { Boundary, Factory, Fault, Options, Port, TurnInput } from "./interactive-recovery.contract.test-support";

export function model(fault: Fault = "none"): Factory {
 const activeInstances = new Map<string, string>();
 let firstCompletedResult: unknown, hasCompletedResult = false;
 return (options: Options, port: Port): Boundary => {
  let active: string | undefined, generation = 0;
  let resumeId = options.resumeId, startup: Promise<void> | undefined;
  let recovery: Promise<void> | undefined, closing: Promise<unknown> | undefined;
  let aborted = false, shutdown = false, lastInput: TurnInput | undefined;
  const start = async (initial: unknown[], resumed?: string) => {
   const captured = generation;
   const id = await port.start({ initial, ...(resumed ? { resumeId: resumed } : {}) });
   if (captured !== generation) {
    if (fault !== "missing-stop-obsolete") await port.stop(fault === "stop-replacement" ? active! : id);
    if (fault === "activate-obsolete") active = id;
    return;
   }
   active = id; activeInstances.set(options.cwd, id);
  };
  const ensureReady = async () => {
   if (active) return;
   if (startup) return await startup;
   const requested = resumeId;
   startup = (async () => {
    const resumed = fault === "discard-resume" ? undefined : requested;
    const initial = resumed ? await port.readMessages(resumed) : [];
    await start(initial, resumed);
    resumeId = undefined;
   })();
   return await startup;
  };
  const recover = async () => {
   if (recovery) return await recovery;
   const previous = active;
   recovery = (async () => {
    if (!previous || shutdown) return;
    if (fault === "reordered-recovery") {
     generation++; active = undefined; await start([]);
     await port.readMessages(previous); return;
    }
    const messages = await port.readMessages(fault === "read-wrong-context" ? "synthetic-foreign/session" : previous).catch(() => []);
    generation++; active = undefined; startup = undefined; resumeId = undefined;
    await start(messages);
   })();
   try { await recovery; } finally { recovery = undefined; }
  };
  const send = async (input: TurnInput, target = active): Promise<unknown> => {
   if (fault === "missing-call") return { syntheticMissingCall: true };
   const otherInstance = [...activeInstances.entries()].find(([root]) => root !== options.cwd)?.[1];
   const addressed = fault === "cross-target" ? otherInstance ?? target :
    ["wrong-target", "foreign-send"].includes(fault) ? "synthetic-foreign/session" : target;
   const forwarded = { sessionId: addressed, ...input };
   if (fault === "trim") forwarded.prompt = forwarded.prompt.trim();
   if (fault === "drop-images") forwarded.userImages = [];
   if (fault === "drop-files") forwarded.userFiles = [];
   if (fault === "swap-attachments") [forwarded.userImages, forwarded.userFiles] = [forwarded.userFiles, forwarded.userImages];
   const first = port.send(forwarded);
   if (fault === "duplicate-call") void port.send({ ...forwarded }).catch(() => {});
   if (fault === "early-settle") { void first.catch(() => {}); return { syntheticEarlyResult: true }; }
   const result = await first;
   if (fault === "late-result-crosslink") {
    if (hasCompletedResult) return firstCompletedResult;
    firstCompletedResult = result; hasCompletedResult = true;
   }
   return fault === "wrong-result" ? { syntheticChangedResult: true } : result;
  };
  const sendCurrentTurn = async (input: TurnInput) => {
   lastInput = input;
   const previous = active;
   try { return await send(input); }
   catch (error) {
    const missing = error !== null && typeof error === "object" && "missingSession" in error && error.missingSession === true;
    if (fault === "swallow-error") return undefined;
    if (fault === "wrong-error") throw new Error("synthetic substituted error");
    if (fault === "unexpected-retry") {
     try { return await send(input); } catch { throw error; }
    }
    if (aborted || shutdown || !missing) throw error;
    await recover();
    if ((aborted || shutdown) && fault === "swallow-original-error") return undefined;
    if (!active || shutdown || (aborted && fault !== "retry-after-abort") || fault === "missing-retry") throw error;
    return await send(input, fault === "retry-stale-session" ? previous : active);
   }
  };
  const cleanup = async () => {
   if (closing) return await closing;
   shutdown = true;
   closing = (async () => {
    if (fault === "early-dispose") await port.dispose("cli_interactive_shutdown");
    await startup?.catch(() => {});
    await recovery?.catch(() => {});
    port.unsubscribe("agent"); port.unsubscribe("pending");
    let summary: unknown;
    if (active) {
     const [row, messages, usage] = await Promise.all([port.getRow(active), port.readMessages(active), port.getUsage(active)]);
     // Scripted undefined row/usage, existing generic summary shape for captured messages.
     if (messages.length && row === undefined && usage === undefined) summary = {
      sessionId: active, startedAt: undefined, provider: undefined, model: undefined, cwd: undefined, messageCount: messages.length,
     };
    }
    try {
     if (fault === "reordered-shutdown-stop" && active) await port.stop(active);
     if (fault !== "missing-shutdown") await port.shutdownHooks();
     if (fault !== "reordered-shutdown-stop" && active) await port.stop(active);
     if (fault === "delivery-after-shutdown" && lastInput) {
      await port.send({ sessionId: active, ...lastInput }).catch(() => {});
     }
    } finally {
     await port.dispose("cli_interactive_shutdown");
     if (fault === "double-dispose") await port.dispose("cli_interactive_shutdown");
    }
    return summary;
   })();
   return await closing;
  };
  return {
   ensureReady, sendCurrentTurn, cleanup,
   activeSessionId: () => active,
   abortAll() {
    if (aborted || !active) return false;
    aborted = true;
    void port.abort(fault === "foreign-abort" ? "synthetic-foreign/session" : active).catch(() => {});
    return true;
   },
   async resetForNewSession() {
    generation++; active = undefined; activeInstances.delete(options.cwd); startup = undefined; resumeId = undefined;
    if (fault === "duplicate-replacement-start") {
     void start([]).catch(() => {});
     void start([]).catch(() => {});
    }
   },
  };
 };
}


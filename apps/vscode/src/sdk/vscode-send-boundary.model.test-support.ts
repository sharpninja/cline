// SPDX-License-Identifier: Apache-2.0
// Independent input-only forwarding model. No production imports or expected objects.
import type { Factory, Fault, SendInput, SendResult } from "./vscode-send-boundary.contract.test-support";
export function modelFactory(fault: Fault = "none"): Factory {
  return inner => {
    let previous: { prompt: string; result: Promise<SendResult> } | undefined;
    return {
      async send(input: SendInput) {
        if (fault === "missing-call" || (fault === "drop-empty" && input.prompt === "")) return { text: "not-called" };
        if (fault === "coalesce-equal" && previous?.prompt === input.prompt) return previous.result;
        const forwarded = fault === "trim-input" ? { ...input, prompt: input.prompt.trim() }
          : fault === "foreign-session" ? { ...input, sessionId: "synthetic-foreign" } : input;
        const pending = inner.send(forwarded);
        previous = { prompt: input.prompt, result: pending };
        if (fault === "early-return") { void pending.catch(() => {}); return { text: "early-return" }; }
        try {
          const result = await pending;
          if (fault === "duplicate-call") await inner.send(forwarded);
          if (fault === "stale-result") return { text: "early-hook-0" };
          if (fault === "summary-result") return { ...result, text: result.text.trim().slice(0, 12) };
          return result;
        } catch (error) {
          if (fault === "duplicate-call") await inner.send(forwarded);
          if (fault === "swallow-error") return { text: "invented-success" };
          throw error;
        }
      },
    };
  };
}

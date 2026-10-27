// SPDX-License-Identifier: Apache-2.0
// Independent test-only model. Operation inputs and scripted consumer callbacks only.
// It never receives cases, expected messages, assertion objects or expected journals.
import type { Factory, Fault, Handler, Message } from "./vscode-receiver-boundary.contract.test-support";
export function model(fault: Fault = "none"): Factory {
  return async registry => {
    const handlers = new Set<Handler>(), seen = new Set<string>();
    return {
      async subscribe(handler, id) {
        handlers.add(handler);
        registry.registerRequest(id, () => { if (fault !== "ignore-cleanup") handlers.delete(handler); }, { type: "partial_message_subscription" }, handler);
      },
      async send(input) {
        if (fault === "drop") return;
        if (fault === "coalesce" && seen.has(input.text)) return;
        seen.add(input.text);
        let message: Message = input;
        if (fault === "trim") message = { ...input, text: input.text.trim() };
        if (fault === "foreign-ts") message = { ...input, ts: 999999 };
        if (fault === "clone-reference") message = structuredClone(input);
        let targets = [...handlers];
        if (fault === "reorder") targets = targets.reverse();
        for (const handler of targets) {
          const invoke = () => handler(message, fault === "wrong-last").catch(() => { if (fault !== "ignore-error") handlers.delete(handler); });
          const pending = invoke();
          if (fault === "await-pending") await pending;
          if (fault === "duplicate") invoke();
        }
      },
    };
  };
}

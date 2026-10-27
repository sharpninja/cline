// SPDX-License-Identifier: Apache-2.0
// Input-only test model. No production imports, expected objects or case names.
import type { Factory, Fault } from "./vscode-recovery-rpc.contract.test-support";
export const model = (fault: Fault = "none"): Factory => (callback, warn) => {
  const sessions = new Map<string, { active: boolean; response?: string }>();
  return {
    configure(context, active) { sessions.set(context, { active }); },
    state(context) { return sessions.get(context)?.response; },
    async invoke(context, request) {
      const session = sessions.get(context);
      const allowed = !!session?.active && ["messageResponse", "yesButtonClicked", "noButtonClicked"].includes(request.responseType);
      if (!allowed) {
        if (fault !== "skip-warning") warn(!session?.active ? "askResponse: No active task to receive response" : "askResponse: Unknown response type: " + request.responseType);
        if (fault === "mutate-forbidden-state" && session) session.response = request.responseType;
        if (fault === "execute-forbidden") await callback(context, request.text, request.images, request.files);
        return fault === "result-shape" ? { wrong: true } : {};
      }
      if (fault === "drop") return {};
      const target = fault === "foreign" ? [...sessions.keys()].find(key => key !== context)! : context;
      const targetState = sessions.get(target)!;
      if (fault !== "missing-state" && fault !== "late-state") targetState.response = request.responseType;
      const text = fault === "trim" ? request.text?.trim() : fault === "undefined-to-empty" ? request.text ?? "" : request.text;
      const images = fault === "drop-images" ? [] : fault === "swap" ? request.files : request.images;
      const files = fault === "drop-files" ? [] : fault === "swap" ? request.images : request.files;
      const response = callback(target, text, images, files);
      if (fault === "late-state") targetState.response = request.responseType;
      if (fault === "duplicate") { const repeated = callback(target, text, images, files); void repeated.catch(() => {}); }
      if (fault === "early") { void response.catch(() => {}); return {}; }
      try { await response; } catch (error) { if (fault !== "swallow") throw error; }
      return fault === "result-shape" ? { wrong: true } : {};
    },
  };
};

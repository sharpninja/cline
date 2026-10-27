// SPDX-License-Identifier: Apache-2.0
// Independent INPUT-ONLY model. No expected objects, case names, product imports or return-outcome summaries.
import type { Identity, Operation, Provider, RecordValue } from "./p1-desktop-audit-boundary.contract.fixture";
export function createAuditBoundaryModel(defect = "none"): Provider {
  return async (operation: Operation, dependencies) => {
    const admitted = new Map<string, Identity>();
    const equalInputs = new Set<string>();
    const earlier = new Map<string, string>();
    const normalize = (value: unknown): unknown => typeof value === "string"
      ? value.replace(/[\u2013\u2014]/g, "-") : structuredClone(value);
    const record = async (phase: RecordValue["phase"], captured: Identity, value: unknown) => {
      const identity = structuredClone(captured);
      if (defect === "wrong-identity") identity.nativeSessionId = "foreign-native";
      await dependencies.write({ phase, identity, value: normalize(value) });
    };
    for (const event of operation.events) {
      if (event.kind === "admission") {
        let value = event.input;
        if (value === undefined && defect !== "invent-inputless") continue;
        if (value === undefined) value = "";
        const captured = structuredClone(event.identity);
        if (defect === "invent-identity" && !captured.nativeSessionId) captured.nativeSessionId = operation.context.nativeSessionId;
        const valid = captured.captureId && captured.requestId && captured.nativeSessionId &&
          captured.workspaceId === operation.context.workspaceId && captured.nativeSessionId === operation.context.nativeSessionId &&
          captured.mcpSessionId === operation.context.mcpSessionId;
        if (!valid && defect !== "accept-invalid-identity") { dependencies.block("missing_identity"); continue; }
        if (defect === "omit-empty" && (value === "" || (Array.isArray(value) && value.length === 0))) continue;
        const equality = JSON.stringify(value);
        if (defect === "merge-equal" && equalInputs.has(equality)) continue;
        equalInputs.add(equality);
        admitted.set(captured.captureId, captured);
        if (defect === "trim-ingress" && typeof value === "string") value = value.trim();
        if (defect === "drop-cr" && typeof value === "string") value = value.replace(/\r/g, "");
        if (defect !== "omit-ingress") await record("ingress", captured, value);
        continue;
      }
      if (event.kind === "afterRun") { earlier.set(event.captureId, event.text); continue; }
      let captured = admitted.get(event.captureId);
      if (!captured && defect === "allow-orphan") captured = { captureId: event.captureId, ...operation.context, requestId: "fabricated-from-final" };
      if (!captured) { dependencies.block("missing_admission"); continue; }
      const text = normalize(defect === "capture-early" ? earlier.get(event.captureId) ?? event.text : event.text) as string;
      let delivered: boolean | undefined;
      if (defect === "deliver-before-audit") delivered = await dependencies.deliver(event.captureId, text);
      if (defect !== "omit-final") await record("final", captured, text);
      if (delivered === undefined) delivered = await dependencies.deliver(event.captureId, text);
      if (delivered || defect === "ignore-delivery-failure") dependencies.confirm(event.captureId);
      else dependencies.block("delivery_failed");
    }
  };
}

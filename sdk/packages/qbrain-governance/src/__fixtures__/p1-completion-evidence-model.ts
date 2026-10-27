// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";

/** TEST ONLY: structural mirror of the pinned S SessionAuditEventRequest/Receipt.
 * No production schema/export/transport or lifecycle is introduced. Native root
 * remains host-captured input, separately checked from the existing S envelope.
 */
export interface CapturedRoot {
 workspacePath: string; agentIdentity: string; nativeSessionId: string;
 mcpSessionId: string; requestId: string;
}
export interface EventEnvelope {
 workspacePath: string; agentIdentity: string; mcpSessionId: string; requestId: string;
 eventId: string; order: number; kind: "action" | "decision" | "dialog";
 payloadJson: string; payloadHash: string;
}
export interface CapturedEvent { root: CapturedRoot; envelope: EventEnvelope }
export interface EventReceipt {
 workspacePath: string; agentIdentity: string; mcpSessionId: string; requestId: string;
 eventId: string; order: number; payloadHash: string; code: string; revision?: unknown;
 reason?: string; storedStatus?: string;
}
export type Operation =
 | { op: "ingress"; root: CapturedRoot; text: string; title: string }
 | { op: "event"; event: CapturedEvent; explicitNoDecision?: boolean }
 | { op: "final"; root: CapturedRoot; text: string }
 | { op: "replay"; event: CapturedEvent }
 | { op: "cancel"; root: CapturedRoot }
 | { op: "verify"; root: CapturedRoot };
export interface PersistenceFault {
 boundary: "submit" | "read" | "replay" | "projection" | "turn" | "trace" | "effect";
 field: string; value?: unknown; occurrence?: number;
}
export interface Observation {
 turns: unknown[]; events: { captured: CapturedEvent; revision: number }[];
 receipts: { boundary: string; eventId: string; receipt: unknown; verified: boolean }[];
 projections: { actions: unknown[]; decisions: unknown[]; dialogs: unknown[] };
 journal: CapturedEvent[]; rejected: CapturedEvent[];
 trace: unknown[]; effects: unknown[]; outcome: string; delivered: boolean;
}
export interface CompletionEvidenceAdapter {
 execute(operations: readonly Operation[]): Promise<Observation>;
}
export const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const normalize = (text: string) => text.replace(/[\u2013\u2014]/gu, "-");
const key = (root: CapturedRoot) => JSON.stringify(Object.values(root));
const eventKey = (event: CapturedEvent) => JSON.stringify([key(event.root), event.envelope.eventId]);
const clone = <T>(value: T): T => structuredClone(value);
const identityFields = ["workspacePath", "agentIdentity", "mcpSessionId", "requestId", "eventId", "order", "payloadHash"] as const;
const positiveRevision = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0;

/** Input-only fake owns commits/revisions and independently scripts responses.
 * No scenario ID, expected records, expected outcome or assertion oracle enters.
 * Faults change actual replies, projection or effects through exercised seams.
 */
export class ScriptedCompletionPersistence implements CompletionEvidenceAdapter {
 constructor(private readonly fault?: PersistenceFault) {}
 async execute(operations: readonly Operation[]): Promise<Observation> {
  const rows = new Map<string, { captured: CapturedEvent; revision: number }>();
  const turns = new Map<string, { root: CapturedRoot; queryText: string; queryTitle: string; response?: string; status: string }>();
  const journal = new Map<string, CapturedEvent>();
  const rejected: CapturedEvent[] = [];
  const receipts: Observation["receipts"] = [];
  const trace: unknown[] = [];
  const effects: unknown[] = [];
  const attested = new Set<string>();
  let revision = 0, matches = 0, outcome = "incomplete";
  const inject = (boundary: PersistenceFault["boundary"], field: string) => {
   if (this.fault?.boundary !== boundary || this.fault.field !== field) return false;
   return matches++ === (this.fault.occurrence ?? 0);
  };
  const emit = (target: string, payload: unknown) => {
   if (!inject("effect", target)) effects.push({ target, payload: clone(payload) });
  };
  const exchange = (method: string, request: unknown, reply: unknown) => {
   if (inject("trace", "omit:" + method)) return;
   const a = { stage: "request", method, value: clone(request) };
   const b = { stage: "response", method, value: clone(reply) };
   if (inject("trace", "callback-before-request")) trace.push(b, a);
   else { trace.push(a); if (!inject("trace", "missing-callback")) trace.push(b); }
  };
  const receiptFor = (event: CapturedEvent, code: string, rev?: number): EventReceipt => {
   const e = event.envelope;
   return { workspacePath: e.workspacePath, agentIdentity: e.agentIdentity, mcpSessionId: e.mcpSessionId,
    requestId: e.requestId, eventId: e.eventId, order: e.order, payloadHash: e.payloadHash,
    code, ...(rev === undefined ? {} : { revision: rev }) };
  };
  const changeReceipt = (boundary: "submit" | "read" | "replay", receipt: EventReceipt): unknown => {
   const result = clone(receipt) as unknown as Record<string, unknown>;
   if (this.fault?.boundary === boundary && inject(boundary, this.fault.field)) {
    if (this.fault.field === "omitted-response") return undefined;
    if (this.fault.field.startsWith("omit:")) delete result[this.fault.field.slice(5)];
    else result[this.fault.field] = this.fault.value;
   }
   return result;
  };
  const validReceipt = (reply: unknown, event: CapturedEvent, expectedCode: string, rev: number) => {
   if (!reply || typeof reply !== "object") return false;
   const value = reply as Record<string, unknown>;
   return value.code === expectedCode && positiveRevision(value.revision) && value.revision === rev &&
    identityFields.every(field => value[field] === event.envelope[field]);
  };
  for (const operation of operations) {
   if (operation.op === "ingress") {
    const turn = { root: clone(operation.root), queryText: normalize(operation.text), queryTitle: operation.title, status: "in_progress" };
    turns.set(key(operation.root), turn); exchange("turn.ingress", operation, { code: "persisted" });
    emit("ingress", turn); continue;
   }
   if (operation.op === "cancel") {
    const turn = turns.get(key(operation.root));
    if (turn) turn.status = "canceled";
    exchange("turn.cancel", operation.root, { status: turn?.status }); emit("canceled", operation.root); continue;
   }
   if (operation.op === "final") {
    const turn = turns.get(key(operation.root));
    if (turn?.status === "in_progress") { turn.response = normalize(operation.text); exchange("turn.final", operation, { code: "persisted" }); emit("final-persisted", turn); }
    continue;
   }
   if (operation.op === "verify") {
    // This fake observes effects; the external SAME assertion contract decides
    // whether a complete set is proven. It never receives expected event lists.
    exchange("turn.read", operation.root, [...turns.values()]); continue;
   }
   const captured = clone(operation.event), id = eventKey(captured), e = captured.envelope;
   const turn = turns.get(key(captured.root));
   journal.set(id, captured); emit("retained", captured);
   if (!turn || turn.status === "canceled" || turn.status === "completed") {
    const receipt = { ...receiptFor(captured, "rejected"), reason: "terminal_turn", storedStatus: turn?.status ?? "missing" };
    rejected.push(captured); receipts.push({ boundary: operation.op === "replay" ? "replay" : "submit", eventId: e.eventId, receipt, verified: false });
    exchange("event.submit", captured, receipt); emit("rejected", captured); journal.delete(id); continue;
   }
   if (operation.op === "event" && e.kind === "decision") {
    exchange("decision.explicit", operation, { code: "invoked" });
   }
   const prior = rows.get(id);
   const immutable = !prior || JSON.stringify(prior.captured) === JSON.stringify(captured);
   if (!immutable || e.payloadHash !== sha256(e.payloadJson)) { outcome = "blocked"; continue; }
   if (!prior) { rows.set(id, { captured, revision: ++revision }); emit("committed", { eventId: e.eventId, revision }); }
   const stored = rows.get(id)!;
   const boundary = operation.op === "replay" ? "replay" : "submit";
   const code = prior ? "unchanged" : "persisted";
   const reply = changeReceipt(boundary, receiptFor(captured, code, stored.revision));
   exchange("event.submit", captured, reply);
   let verified = validReceipt(reply, captured, code, stored.revision);
   const read = changeReceipt("read", receiptFor(stored.captured, "persisted", stored.revision));
   exchange("event.read", { root: captured.root, eventId: e.eventId }, read);
   verified = verified && validReceipt(read, captured, "persisted", stored.revision);
   receipts.push({ boundary, eventId: e.eventId, receipt: clone(reply), verified });
   receipts.push({ boundary: "read", eventId: e.eventId, receipt: clone(read), verified });
   if (verified) { journal.delete(id); emit("retired", { eventId: e.eventId }); }
   if (operation.op === "event" && operation.explicitNoDecision && verified) attested.add(key(captured.root));
  }
  let events = clone([...rows.values()].sort((a,b) => a.captured.envelope.order - b.captured.envelope.order));
  const projections: Observation["projections"] = { actions: [], decisions: [], dialogs: [] };
  for (const row of events) {
   const e = row.captured.envelope, body = JSON.parse(e.payloadJson) as Record<string, unknown>;
   const reference = { eventId: e.eventId, order: e.order, root: row.captured.root };
   if (e.kind === "action") projections.actions.push({ ...reference, ...body });
   else if (e.kind === "dialog") projections.dialogs.push({ ...reference, ...body });
   else {
    projections.decisions.push({ ...reference, conclusion: body.conclusion });
    projections.actions.push({ ...reference, type: "design_decision", description: body.conclusion, status: "completed" });
    projections.dialogs.push({ ...reference, role: "model", category: "decision", content: body.conclusion, timestamp: body.timestamp });
   }
  }
  if (this.fault?.boundary === "projection") {
   const list = projections[this.fault.field as keyof typeof projections];
   if (Array.isArray(list)) {
    if (this.fault.value === "omit") list.pop();
    else if (this.fault.value === "duplicate") list.push(clone(list[0]));
    else if (this.fault.value === "reorder") list.reverse();
    else if (this.fault.value === "duplicate-loss") list[list.length - 1] = clone(list[0]);
    else if (this.fault.value === "rebind") (list[0] as { eventId: string }).eventId = "wrong-event";
   } else if (this.fault.field === "events") {
    if (this.fault.value === "omit") events.pop();
    else if (this.fault.value === "duplicate") events.push(clone(events[0]));
    else if (this.fault.value === "reorder") events.reverse();
    else if (this.fault.value === "stale") events[0].revision--;
    else if (this.fault.value === "corrupt") events[0].captured.envelope.payloadJson += " ";
    else if (this.fault.value === "rebind") events[0].captured.root.nativeSessionId = "wrong-native";
   }
  }
  const observedTurns = clone([...turns.values()]);
  if (this.fault?.boundary === "turn") {
   const turn = observedTurns[0] as unknown as Record<string, unknown>;
   const target = this.fault.field.startsWith("queryText:") ? "queryText" : this.fault.field.startsWith("response:") ? "response" : this.fault.field.startsWith("queryTitle:") ? "queryTitle" : undefined;
   if (target) {
    const source = String(turn[target]);
    const mode = this.fault.field.slice(this.fault.field.indexOf(":") + 1);
    if (mode === "summary") turn[target] = "summary";
    if (mode === "truncate") turn[target] = source.slice(0, -1);
    if (mode === "trim") turn[target] = source.trim();
    if (mode === "newline") turn[target] = source.replace(/\r\n?/gu, "\n");
    if (mode === "unicode") turn[target] = source.normalize("NFC");
    if (mode === "literal") turn[target] = source.replaceAll("\\u00e9", "é");
   }
   if (this.fault.field.startsWith("root:")) (turn.root as Record<string, unknown>)[this.fault.field.slice(5)] = this.fault.value;
   else if (this.fault.field === "omit-ingress") observedTurns.shift();
   else if (this.fault.field === "extra-final") turn.response = "invented final";
   else if (this.fault.field === "normalize-newline") turn.queryText = String(turn.queryText).replace(/\r\n?/gu,"\n");
   else if (this.fault.field === "trim") turn.response = String(turn.response).trim();
   else if (this.fault.field === "summary") turn.response = "summary";
   else if (this.fault.field === "normalize-unicode") turn.response = String(turn.response).normalize("NFC");
   else if (this.fault.field === "literal-unescape") turn.response = String(turn.response).replaceAll("\\u00e9", "é");
  }
  outcome = journal.size || rejected.length || receipts.some(r => !r.verified) ? "blocked" :
   observedTurns.every(t => t.status === "canceled") ? "canceled" : "evidence-ready";
  if (inject("effect", "invent-success")) { outcome = "evidence-ready"; effects.push({target:"operator-delivery",payload:{}}); }
  // Attestation is separately captured by the explicit decision invocation.
  emit("decision-attestations", [...attested]);
  return { turns: observedTurns, events, receipts, projections, journal: clone([...journal.values()]), rejected,
   trace, effects, outcome, delivered: effects.some(x => (x as {target:string}).target === "operator-delivery") };
 }
}

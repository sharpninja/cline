// SPDX-License-Identifier: Apache-2.0
import type { CapturedRoot, CapturedEvent, EventEnvelope, EventReceipt, Operation, Observation } from "./p1-completion-evidence-model";
import { createHash } from "node:crypto";

/** Independent fixtures. Only input is passed to the adapter; expected records
 * remain with the runner. S envelope/projection shapes are source-pinned in the
 * receipt, not proposed as new SDK APIs. Existing 501 scenarios are untouched.
 */
export const completionAllocation = {
 requirements: ["FR-QB-003", "FR-QB-004", "FR-QB-005", "TR-QB-AUDIT-001", "TR-QB-COMPLETION-001"],
 tests: ["TEST-QB-007", "TEST-QB-008", "TEST-QB-009", "TEST-QB-010", "TEST-QB-011", "TEST-QB-012", "TEST-QB-069"],
 nativeSteps: ["UC-QB-002.flow-3.step-3", "UC-QB-002.flow-3.step-29", "UC-QB-002.flow-4.step-4", "UC-QB-002.flow-4.step-30", "UC-QB-003.flow-5.step-5", "UC-QB-003.flow-5.step-31", "UC-QB-003.flow-6.step-6", "UC-QB-003.flow-6.step-32"],
} as const;
export interface CompletionCase { name: string; input: readonly Operation[]; expected: Observation; attested: boolean; canceled: boolean; terminal: boolean }
const rootA: CapturedRoot = { workspacePath: "F:\\fixture\\K\\workspace", agentIdentity: "ClineQb", nativeSessionId: "native-fixture-a", mcpSessionId: "Cline-20260101T000000Z-fixture", requestId: "req-20260101T000000Z-fixture" };
const stamp = "2026-01-01T00:00:01.0000000Z";
const actionBody = { type: "tool_execution", description: "Inspect fixture", status: "completed", filePath: "F:/fixture/K/item.ts" };
const dialogBody = { role: "tool", category: "tool_result", content: "retained result\r\n\tΩ", timestamp: stamp };
const decisionText = "Keep independent event identities";
const attestationText = "No design decision was made in this development turn.";
const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const captured = (root: CapturedRoot, ordinal: number, kind: EventEnvelope["kind"], body: unknown): CapturedEvent => {
 const payloadJson = " \r\n" + JSON.stringify(body) + "\r\n";
 return { root, envelope: { workspacePath: root.workspacePath, agentIdentity: root.agentIdentity, mcpSessionId: root.mcpSessionId, requestId: root.requestId,
  eventId: `10000000-0000-4000-8000-${String(ordinal).padStart(12,"0")}`, order: ordinal, kind, payloadJson, payloadHash: hash(payloadJson) } };
};
const receipt = (e: CapturedEvent, code: string, revision?: number): EventReceipt => ({workspacePath:e.envelope.workspacePath,agentIdentity:e.envelope.agentIdentity,mcpSessionId:e.envelope.mcpSessionId,requestId:e.envelope.requestId,eventId:e.envelope.eventId,order:e.envelope.order,payloadHash:e.envelope.payloadHash,code,...(revision===undefined?{}:{revision})});
const variants = [
 { name:"CRLF", request:"  Inspect\r\n\r\n- exact\t\r\n", result:"  Result\r\n\tpassed\r\n\r\n", requestExpected:"  Inspect\r\n\r\n- exact\t\r\n", resultExpected:"  Result\r\n\tpassed\r\n\r\n" },
 { name:"CR", request:"Inspect\r\rrequest\r", result:"Result\r\rvalue\r", requestExpected:"Inspect\r\rrequest\r", resultExpected:"Result\r\rvalue\r" },
 { name:"mixed", request:"Inspect\r\nline\nend\r", result:"Result\r\nline\nend\r", requestExpected:"Inspect\r\nline\nend\r", resultExpected:"Result\r\nline\nend\r" },
 { name:"Markdown", request:"```md\r\n\t# complete\r\n```\r\n", result:"```text\r\n  exact\t\r\n```\r\n", requestExpected:"```md\r\n\t# complete\r\n```\r\n", resultExpected:"```text\r\n  exact\t\r\n```\r\n" },
 { name:"Unicode", request:"é e\u0301 中 🚀\r\n", result:"é e\u0301 中 🚀\r\n\u00a0", requestExpected:"é e\u0301 中 🚀\r\n", resultExpected:"é e\u0301 中 🚀\r\n\u00a0" },
 { name:"literal-escapes", request:"literal \\r\\n \\u00e9\r\n", result:" literal \\u00e9 \\r\\n\r\n ", requestExpected:"literal \\r\\n \\u00e9\r\n", resultExpected:" literal \\u00e9 \\r\\n\r\n " },
 { name:"decoded-dashes", request:"Inspect – — - --\r\n", result:" Result — – --\r\n ", requestExpected:"Inspect - - - --\r\n", resultExpected:" Result - - --\r\n " },
 { name:"JSON-escaped-decoded-dashes", request:JSON.parse('"Inspect \\u2013 \\u2014\\r\\n"') as string, result:JSON.parse('" Result \\u2014 \\u2013\\r\\n "') as string, requestExpected:"Inspect - -\r\n", resultExpected:" Result - -\r\n " },
] as const;

/** Expected projections explicitly enumerate the S decision triple; no fake or
 * production result is used to construct them. Expected interaction script is
 * fixture-authored, including replay revision equality and no extra application.
 */
export const completionEvidenceCases: readonly CompletionCase[] = variants.flatMap(v =>
 ["decision-replay", "equal-decision-distinct-events", "attested-none", "canceled", "terminal-rejection", "native-root-isolation"].map(mode => {
  const attested = mode === "attested-none", canceled = mode === "canceled" || mode === "terminal-rejection", terminal = mode === "terminal-rejection";
  const root = { ...rootA };
  const secondRoot = { ...root, nativeSessionId:"native-fixture-b" };
  const title = "Inspect complete fixture evidence";
  const events = [captured(root,1,"action",actionBody), captured(root,2,"dialog",dialogBody)];
  if (!canceled) events.push(captured(root,3,"decision",{conclusion:attested?attestationText:decisionText,timestamp:stamp}));
  if (mode === "equal-decision-distinct-events") events.push(captured(root,4,"decision",{conclusion:decisionText,timestamp:stamp}));
  const rejectedEvent = captured(root,9,"action",actionBody);
  const input: Operation[] = [{op:"ingress",root,text:v.request,title}, ...events.map(event => ({op:"event" as const,event,...(attested&&event.envelope.kind==="decision"?{explicitNoDecision:true}:{})}))];
  const expected: Observation = { turns:[], events:events.map((e,i)=>({captured:e,revision:i+1})),receipts:[], projections:{actions:[],decisions:[],dialogs:[]},journal:[],rejected:[],trace:[],effects:[],outcome:terminal?"blocked":canceled?"canceled":"evidence-ready",delivered:false };
  const turn = {root,queryText:v.requestExpected,queryTitle:title,status:"in_progress",...(!canceled?{response:v.resultExpected}:{})};
  const ingressTurn={root,queryText:v.requestExpected,queryTitle:title,status:"in_progress"};
  expected.effects.push({target:"ingress",payload:ingressTurn});
  expected.trace.push({stage:"request",method:"turn.ingress",value:input[0]},{stage:"response",method:"turn.ingress",value:{code:"persisted"}});
  events.forEach((e,i) => {
   const ref={eventId:e.envelope.eventId,order:e.envelope.order,root};
   if (i===0) expected.projections.actions.push({...ref,...actionBody});
   else if (i===1) expected.projections.dialogs.push({...ref,...dialogBody});
   else {
    const conclusion=attested?attestationText:decisionText;
    expected.projections.decisions.push({...ref,conclusion});
    expected.projections.actions.push({...ref,type:"design_decision",description:conclusion,status:"completed"});
    expected.projections.dialogs.push({...ref,role:"model",category:"decision",content:conclusion,timestamp:stamp});
   }
   if(i>=2) expected.trace.push({stage:"request",method:"decision.explicit",value:input[i+1]},{stage:"response",method:"decision.explicit",value:{code:"invoked"}});
   const submit=receipt(e,"persisted",i+1),read=receipt(e,"persisted",i+1);
   expected.receipts.push({boundary:"submit",eventId:e.envelope.eventId,receipt:submit,verified:true},{boundary:"read",eventId:e.envelope.eventId,receipt:read,verified:true});
   expected.effects.push({target:"retained",payload:e},{target:"committed",payload:{eventId:e.envelope.eventId,revision:i+1}},{target:"retired",payload:{eventId:e.envelope.eventId}});
   expected.trace.push({stage:"request",method:"event.submit",value:e},{stage:"response",method:"event.submit",value:submit},{stage:"request",method:"event.read",value:{root,eventId:e.envelope.eventId}},{stage:"response",method:"event.read",value:read});
  });
  if(canceled){
   turn.status="canceled"; input.push({op:"cancel",root});expected.effects.push({target:"canceled",payload:root});
   expected.trace.push({stage:"request",method:"turn.cancel",value:root},{stage:"response",method:"turn.cancel",value:{status:"canceled"}});
   if(terminal){
    input.push({op:"event",event:rejectedEvent}); const reject={...receipt(rejectedEvent,"rejected"),reason:"terminal_turn",storedStatus:"canceled"};
    expected.rejected.push(rejectedEvent);expected.receipts.push({boundary:"submit",eventId:rejectedEvent.envelope.eventId,receipt:reject,verified:false});
    expected.effects.push({target:"retained",payload:rejectedEvent},{target:"rejected",payload:rejectedEvent});
    expected.trace.push({stage:"request",method:"event.submit",value:rejectedEvent},{stage:"response",method:"event.submit",value:reject});
   }
  } else {
   input.push({op:"final",root,text:v.result});expected.effects.push({target:"final-persisted",payload:turn});
   expected.trace.push({stage:"request",method:"turn.final",value:{op:"final",root,text:v.result}},{stage:"response",method:"turn.final",value:{code:"persisted"}});
   const original=events[2];input.push({op:"replay",event:original});
   const again=receipt(original,"unchanged",3),read=receipt(original,"persisted",3);
   expected.receipts.push({boundary:"replay",eventId:original.envelope.eventId,receipt:again,verified:true},{boundary:"read",eventId:original.envelope.eventId,receipt:read,verified:true});
   expected.effects.push({target:"retained",payload:original},{target:"retired",payload:{eventId:original.envelope.eventId}});
   expected.trace.push({stage:"request",method:"event.submit",value:original},{stage:"response",method:"event.submit",value:again},{stage:"request",method:"event.read",value:{root,eventId:original.envelope.eventId}},{stage:"response",method:"event.read",value:read});
  }
  expected.turns.push(turn);
  if(mode==="native-root-isolation"){
   input.push({op:"ingress",root:secondRoot,text:v.request,title},{op:"final",root:secondRoot,text:v.result});
   const ingress={root:secondRoot,queryText:v.requestExpected,queryTitle:title,status:"in_progress"};
   const complete={...ingress,response:v.resultExpected};expected.turns.push(complete);
   expected.effects.push({target:"ingress",payload:ingress},{target:"final-persisted",payload:complete});
   expected.trace.push({stage:"request",method:"turn.ingress",value:{op:"ingress",root:secondRoot,text:v.request,title}},{stage:"response",method:"turn.ingress",value:{code:"persisted"}}, {stage:"request",method:"turn.final",value:{op:"final",root:secondRoot,text:v.result}},{stage:"response",method:"turn.final",value:{code:"persisted"}});
  }
  input.push({op:"verify",root});
  expected.trace.push({stage:"request",method:"turn.read",value:root},{stage:"response",method:"turn.read",value:expected.turns});
  expected.effects.push({target:"decision-attestations",payload:attested?[JSON.stringify(Object.values(root))]:[]});
  return {name:`${v.name}: ${mode}`,input,expected,attested,canceled,terminal};
 }));

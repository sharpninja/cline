// SPDX-License-Identifier: Apache-2.0
// FR-QB-002/005; TR-QB-TRUST-001/RUNTIME-001; AC/TEST-QB-005/014.
// Shared assertion/interaction runner for Mock and later approved actual binding.
import assert from "node:assert/strict";
import {capturedBackgroundLaunch,rereadingBackgroundLaunch,type BackgroundContext,type BackgroundDependencies,type BackgroundLaunch} from "./menubar-context.test-support";
type Kind="empty"|"no-context"|"auth-error"|"start-error"|"send-error"|"unchanged"|"workspace-change"|"provider-change"|"model-change"|"all-change"|"overlap";
type Fault="none"|"wrong-auth"|"wrong-session-id"|"start-throws"|"send-throws"|"ignore-error"|"invent-prompt"|"invent-context";
type Call={kind:string;value:unknown};
const a:BackgroundContext={workspaceRoot:"synthetic-workspace-A",cwd:"synthetic-cwd-A",provider:"direct-A",model:"model-A"};
const b:BackgroundContext={workspaceRoot:"synthetic-workspace-B",cwd:"synthetic-cwd-B",provider:"direct-B",model:"model-B"};
const copy=<T>(v:T):T=>structuredClone(v);
const prompt="  ## Captured request\r\n雪\n\n  ";
function expectedConfig(c:BackgroundContext) {
  // Requirement/original-contract expected fields. Never supplied to the model.
  return {workspaceRoot:c.workspaceRoot,cwd:c.cwd??c.workspaceRoot,provider:c.provider,model:c.model,apiKey:`synthetic-only-${c.provider}`,enableTools:true,enableSpawn:false,enableTeams:true};
}
const authCall=(c:BackgroundContext):Call=>({kind:"auth",value:c.provider});
const startCall=(c:BackgroundContext):Call=>({kind:"start",value:{...expectedConfig(c),autoApproveTools:true,source:"cline-menubar",interactive:false}});
const sendCall=(c:BackgroundContext,id:string,text:string):Call=>({kind:"send",value:{sessionId:id,input:{config:expectedConfig(c),prompt:text.trim()}}});
const notifyCall=(value:string):Call=>({kind:"notify",value});
export async function assertBackgroundContext(kind:Kind,launch:BackgroundLaunch=capturedBackgroundLaunch,fault:Fault="none",productionBound=false) {
  let current:BackgroundContext|undefined=kind==="no-context"?undefined:copy(a);
  const calls:Call[]=[],reads:(BackgroundContext|undefined)[]=[];
  const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
  const dependencies:BackgroundDependencies={
    context(){const value=fault==="invent-context"?copy(a):current;reads.push(copy(value));return value;},
    auth(provider){calls.push({kind:"auth",value:provider});if(kind==="auth-error"&&fault!=="ignore-error")throw new Error("synthetic-auth-failure");return {apiKey:fault==="wrong-auth"?"foreign-key":`synthetic-only-${provider}`};},
    async start(input){calls.push({kind:"start",value:copy(input)});if(input.provider===a.provider){entered.resolve();await release.promise;}
      if((kind==="start-error"&&fault!=="ignore-error")||fault==="start-throws")throw new Error("synthetic-start-failure");
      return {sessionId:fault==="wrong-session-id"?"foreign-session":input.provider===a.provider?"session-A":"session-B"};},
    async send(sessionId,input){calls.push({kind:"send",value:{sessionId,input:copy(input)}});if((kind==="send-error"&&fault!=="ignore-error")||fault==="send-throws")throw new Error("synthetic-send-failure");},
    notify(body){calls.push({kind:"notify",value:body});},
  };
  const actualPrompt=kind==="empty"?(fault==="invent-prompt"?"injected work":" \r\n\t "):prompt;
  const pending=launch(actualPrompt,dependencies);
  await Promise.race([entered.promise,pending]);
  if(kind==="workspace-change")current={...a,workspaceRoot:b.workspaceRoot,cwd:b.cwd};
  if(kind==="provider-change")current={...a,provider:b.provider};
  if(kind==="model-change")current={...a,model:b.model};
  if(kind==="all-change"||kind==="overlap")current=copy(b);
  try {if(kind==="overlap")await launch("## B request\r\n\t雪",dependencies);}finally{release.resolve();await pending;}
  let expected:Call[];
  if(kind==="empty")expected=[];
  else if(kind==="no-context")expected=[notifyCall("No recent workspace and model context is available yet.")];
  else if(kind==="auth-error")expected=[authCall(a),notifyCall("synthetic-auth-failure")];
  else if(kind==="start-error")expected=[authCall(a),startCall(a),notifyCall("synthetic-start-failure")];
  else if(kind==="send-error")expected=[authCall(a),startCall(a),sendCall(a,"session-A",prompt),notifyCall("synthetic-send-failure")];
  else if(kind==="overlap")expected=[authCall(a),startCall(a),authCall(b),startCall(b),sendCall(b,"session-B","## B request\r\n\t雪"),sendCall(a,"session-A",prompt)];
  else expected=[authCall(a),startCall(a),sendCall(a,"session-A",prompt)];
  try {assert.deepStrictEqual(calls,expected,`${kind}: start/send must retain captured context and server session identity`);}
  catch(error){if(error instanceof assert.AssertionError)Object.assign(error,{interactionEvidence:{calls,contextReads:reads,finalContext:current}});throw error;}
  return {kind,fault,calls,contextReads:reads,finalContext:current,evidenceLevel:productionBound?"isolated-production-background-function":"independent-background-model-only",actualMenubar:false,productionBound};
}
export async function proveBackgroundContextGate(launch:BackgroundLaunch=capturedBackgroundLaunch,productionBound=false) {
  const kinds:Kind[]=["empty","no-context","auth-error","start-error","send-error","unchanged","workspace-change","provider-change","model-change","all-change","overlap"];
  const evidence:unknown[]=[],failures:{name:string;error:string}[]=[];let passed=0,rejectingControls=0,plannedControls=0;
  for(const kind of kinds){
    try{evidence.push(await assertBackgroundContext(kind,launch,"none",productionBound));passed++;}catch(error){failures.push({name:kind,error:String(error)});}
    const faults:Fault[]=kind==="empty"?["invent-prompt"]:kind==="no-context"?["invent-context"]:kind.endsWith("error")?["ignore-error"]:["wrong-auth","wrong-session-id","start-throws","send-throws"];
    for(const fault of faults){plannedControls++;let rejected=false;try{await assertBackgroundContext(kind,launch,fault,productionBound);}catch(error){if(error instanceof assert.AssertionError){rejectingControls++;rejected=true;evidence.push({kind,fault,actual:error.actual,interactionEvidence:(error as assert.AssertionError&{interactionEvidence:unknown}).interactionEvidence});}else failures.push({name:`${kind}/${fault}`,error:`Wrong exception: ${String(error)}`});}if(!rejected)failures.push({name:`${kind}/${fault}`,error:"Incorrect dependency interaction accepted"});}
    if(["workspace-change","provider-change","model-change","all-change","overlap"].includes(kind)){
      plannedControls++;let rejected=false;try{await assertBackgroundContext(kind,rereadingBackgroundLaunch);}catch(error){if(error instanceof assert.AssertionError){rejectingControls++;rejected=true;evidence.push({kind,fault:"source-faithful-rereading-countermodel",actual:error.actual,interactionEvidence:(error as assert.AssertionError&{interactionEvidence:unknown}).interactionEvidence});}else failures.push({name:kind,error:`Wrong countermodel exception: ${String(error)}`});}if(!rejected)failures.push({name:kind,error:"Source-faithful context-rereading defect was accepted"});
    }
  }
  return {mode:productionBound?"Production":"Mock",scenarios:kinds.length,passed,plannedControls,rejectingControls,failed:failures.length,skipped:0,failures,evidence,productionBound,actualMenubar:false};
}
if(process.argv.includes("--mock-proof")||process.argv.includes("--production-proof")){const bound=process.argv.includes("--production-proof");const launch=bound?(await import("../../../examples/menubar/sidecar/background-chat")).launchBackgroundChat:capturedBackgroundLaunch;const result=await proveBackgroundContextGate(launch,bound);console.log(JSON.stringify(result));if(result.failed)process.exitCode=1;}
else {const {it}=await import("vitest");it("preserves menubar captured context across original background launch and rejecting interactions",async()=>{const result=await proveBackgroundContextGate();assert.deepStrictEqual(result.failures,[]);assert.equal(result.rejectingControls,result.plannedControls);});it("binds the SAME captured-context assertions and rejecting interactions to the real menubar background function",async()=>{const {launchBackgroundChat}=await import("../../../examples/menubar/sidecar/background-chat");const result=await proveBackgroundContextGate(launchBackgroundChat,true);assert.deepStrictEqual(result.failures,[]);assert.equal(result.passed,11);assert.equal(result.rejectingControls,result.plannedControls);});}


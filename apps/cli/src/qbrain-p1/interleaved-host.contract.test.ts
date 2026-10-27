// SPDX-License-Identifier: Apache-2.0
// P1: FR-QB-002/005, TR-QB-TRUST-001/RUNTIME-001, TEST-QB-005/014/072.
// Model evidence only. No SDK, native host, transport or provider is executed.
import assert from "node:assert/strict";
import { assertScenario, baseInput, effect, expectedSuccess, validReplies, type HostProvider, type Reply, type Scenario } from "./host-contract";
import { InterleavedHostModel } from "./interleaved-host.test-support";

type History = "delayed-success" | "identical-text" | "changed-execution-policy" | "changed-policy" | "foreign-audit";
type Callback = { context:string; boundary:string; request:unknown; response:unknown; phase:"before"|"after" };
type Factory = (script:Reply[], dependency:(boundary:string,request:unknown,response:Reply|undefined)=>Promise<unknown>)=>HostProvider;
type Fault = "none" | "early-release" | "wrong-result" | "foreign-ingress" | "foreign-audit" | "missing-provider" | "missing-authorization" | "reordered-audit-completion" | "queued-audit" | "missing-delivery" | "stale-completion-policy" | "ignore-required-refusal";
const factory:Factory=(script,dependency)=>new InterleavedHostModel(script,dependency);
const clone=<T>(value:T):T=>structuredClone(value);
function scenarios(host:string,entry:string,history:History):[Scenario,Scenario] {
  const a=baseInput(host,entry), b=baseInput(host,entry);
  for(const [input,id] of [[a,"A"],[b,"B"]] as const) {
    input.binding={workspace:`synthetic-${id}`,nativeSession:`native-${id}`,agent:`agent-${id}`,session:`session-${id}`,request:`request-${id}`,event:`ingress-${id}`,policy:`policy-${id}`};
    input.home=`synthetic-home-${id}`;input.root=`${input.home}/.cline-qb/data`;input.upstream=`${input.home}/.cline`;
    input.port=id==="A"?39121:39122;input.proxy=`http://synthetic-proxy-${id}.invalid`;
    input.request=`## ${id} ${entry}\r\n\tExact 雪\n\n`;input.result=`## ${id} result\r\n  **exact** 雪\n\n`;
    input.operation=entry==="fork"?"delegate":entry==="recovery"?"recover":"work";
  }
  // Replacement context deliberately shares workspace but not request/session/policy.
  if(history==="changed-policy" || history==="changed-execution-policy") b.binding.workspace=a.binding.workspace;
  if(history==="identical-text") {b.request=a.request;b.result=a.result;}
  const make=(input:typeof a):Scenario=>({name:`${host}/${entry}/${history}/${input.binding.request}`,ac:["AC-QB-005","AC-QB-014","AC-QB-069","AC-QB-072"],uc:["UC-QB-002","UC-QB-004"],input,replies:validReplies(input),expected:expectedSuccess(input)});
  const sa=make(a), sb=make(b);
  if(history==="changed-policy") {
    sa.replies.find(r=>r.boundary==="completion")!.value={allow:false,policy:b.binding.policy};
    sa.expected=[...sa.expected.slice(0,10),effect("blocked","completion"),effect("canary",a.canary)];
  }
  if(history==="changed-execution-policy") {
    sa.replies.find(r=>r.boundary==="authorize")!.value={allow:false,policy:b.binding.policy};
    sa.expected=[...sa.expected.slice(0,7),effect("blocked","authorization"),effect("canary",a.canary)];
  }
  if(history==="foreign-audit") {
    (sa.replies.find(r=>r.boundary==="audit")!.value as {binding:unknown}).binding=clone(b.binding);
    sa.expected=[...sa.expected.slice(0,9),effect("blocked","audit"),effect("canary",a.canary)];
  }
  return [sa,sb];
}

// ONE input/assertion/interaction runner, accepting the later approved binding.
// Only operation inputs, scripted responses and dependency callbacks reach a provider.
export async function runInterleavedHistory(host:string,entry:string,history:History,fault:Fault="none",bind:Factory=factory) {
  const [a,b]=scenarios(host,entry,history), script=clone(a.replies), callbacks:Callback[]=[];
  const alter=(boundary:string,change:(r:Reply)=>void)=>{const r=script.find(r=>r.boundary===boundary);assert.ok(r);change(r);};
  if(fault==="wrong-result") alter("provider",r=>(r.value as {text:string}).text="foreign summary");
  if(fault==="foreign-ingress") alter("ingress",r=>(r.value as {binding:unknown}).binding=clone(b.input.binding));
  if(fault==="foreign-audit") alter("audit",r=>(r.value as {binding:unknown}).binding=clone(b.input.binding));
  if(fault==="queued-audit") alter("audit",r=>(r.value as {code:string}).code="queued");
  if(fault==="missing-provider" || fault==="missing-authorization" || fault==="missing-delivery") {
    const boundary=fault==="missing-provider"?"provider":fault==="missing-delivery"?"delivery":"authorize";
    script.splice(script.findIndex(r=>r.boundary===boundary),1);
  }
  if(fault==="reordered-audit-completion") {const i=script.findIndex(r=>r.boundary==="audit");[script[i],script[i+1]]=[script[i+1],script[i]];}
  if(fault==="stale-completion-policy") alter("completion",r=>r.value={allow:true,policy:b.input.binding.policy});
  if(fault==="ignore-required-refusal") {
    if(history==="changed-policy") alter("completion",r=>r.value={allow:true,policy:a.input.binding.policy});
    else if(history==="changed-execution-policy") alter("authorize",r=>r.value={allow:true,policy:a.input.binding.policy});
    else if(history==="foreign-audit") alter("audit",r=>(r.value as {binding:unknown}).binding=clone(a.input.binding));
    else throw new Error("Invalid control for success history");
  }
  const heldBoundary=history==="changed-execution-policy"?"authorize":"provider";
  const entered=Promise.withResolvers<void>(), release=Promise.withResolvers<void>();
  const dependency=(context:string)=>async(boundary:string,request:unknown,response:Reply|undefined)=>{
    callbacks.push({context,boundary,request:clone(request),response:clone(response?.value),phase:"before"});
    if(context==="A" && boundary===heldBoundary) {entered.resolve();if(fault!=="early-release")await release.promise;}
    const value=clone(response?.value);
    callbacks.push({context,boundary,request:clone(request),response:clone(value),phase:"after"});
    return value;
  };
  const pa=bind(script,dependency("A")), pb=bind(clone(b.replies),dependency("B"));
  // Attach a rejection handler immediately; controls may fail before the pause.
  try {
  const pending=assertScenario(pa,a).then(value=>({value,error:undefined}),error=>({value:undefined,error}));
  await Promise.race([entered.promise,pending]);
  const beforeB=pa.snapshot();
  if(heldBoundary==="authorize")assert.deepStrictEqual(beforeB.providerCalls,[],"Changed execution authorization precedes any provider effect");
  let bObserved:unknown, aResult:Awaited<typeof pending>;
  try {
    // The interrupted context has emitted provider call, but cannot have audited/delivered it.
    assert.deepStrictEqual(beforeB.deliveries,[],"A cannot deliver while its provider callback is held");
    assert.deepStrictEqual(beforeB.persisted.map(([,v])=>v.result),[undefined],"A result cannot be persisted before provider returns");
    bObserved=await assertScenario(pb,b);
    assert.deepStrictEqual(pa.snapshot(),beforeB,"B must not mutate A's owned lifecycle state");
    assert.deepStrictEqual(pb.snapshot().deliveries,[{binding:b.input.binding,text:b.input.result}],"B completes independently");
  } finally {release.resolve();aResult=await pending;}
  if(aResult.error)throw aResult.error;
  const bDelivery=callbacks.findIndex(c=>c.context==="B"&&c.boundary==="delivery"&&c.phase==="after");
  const aReturn=callbacks.findIndex(c=>c.context==="A"&&c.boundary===heldBoundary&&c.phase==="after");
  assert.ok(bDelivery>=0 && aReturn>bDelivery,"A's actual delayed callback follows B's delivery");
  // Callback capture is independent from each model's effects/snapshot.
  for(const c of callbacks.filter(c=>["ingress","authorize","provider","audit","completion","delivery"].includes(c.boundary))) {
    const input=c.context==="A"?a.input:b.input;
    assert.deepStrictEqual((c.request as {binding:unknown}).binding,input.binding,"Every callback request retains captured context");
  }
  return {host,entry,history,fault,callbacks,aObserved:aResult.value,bObserved,aState:pa.snapshot(),bState:pb.snapshot(),evidenceLevel:"independent-async-model-only",productionBound:false,actualHost:false};
  } catch(error) {
    if(error instanceof assert.AssertionError)Object.assign(error,{interactionEvidence:{callbacks,aState:pa.snapshot(),bState:pb.snapshot()}});
    throw error;
  }
}
export async function proveInterleavedGate() {
  const evidence:unknown[]=[], failures:{name:string;error:string}[]=[];let passed=0,rejectingControls=0,plannedControls=0;
  const routes=[["cli","resume"],["hub","fork"],["vscode","rebuild"]] as const;
  for(const [host,entry] of routes)for(const history of ["delayed-success","identical-text","changed-execution-policy","changed-policy","foreign-audit"] as const) {
    const name=`${host}/${entry}/${history}`;
    try {evidence.push(await runInterleavedHistory(host,entry,history));passed++;}catch(error){failures.push({name,error:String(error)});}
    const faults:Fault[]=(history==="delayed-success"||history==="identical-text")?["early-release","wrong-result","foreign-ingress","foreign-audit","missing-provider","missing-authorization","reordered-audit-completion","queued-audit","missing-delivery","stale-completion-policy"]:["ignore-required-refusal"];
    for(const fault of faults) {
      plannedControls++;let rejected=false;
      try {await runInterleavedHistory(host,entry,history,fault);}catch(error){
        if(error instanceof assert.AssertionError){rejected=true;rejectingControls++;evidence.push({name,fault,rejection:error.message,actual:error.actual,interactionEvidence:(error as assert.AssertionError & {interactionEvidence:unknown}).interactionEvidence});}
        else failures.push({name:`${name}/${fault}`,error:`Wrong exception class: ${String(error)}`});
      }
      if(!rejected)failures.push({name:`${name}/${fault}`,error:"Incorrect interaction was accepted"});
    }
  }
  return {mode:"Mock",histories:15,requests:30,passed,plannedControls,rejectingControls,failed:failures.length,skipped:0,failures,evidence,productionBound:false,actualHost:false};
}
if(process.argv.includes("--mock-proof")) {
  const result=await proveInterleavedGate();console.log(JSON.stringify(result));if(result.failed)process.exitCode=1;
}
else {
  const {it}=await import("vitest");
  for(const [host,entry] of [["cli","resume"],["hub","fork"],["vscode","rebuild"]] as const)
    for(const history of ["delayed-success","identical-text","changed-execution-policy","changed-policy","foreign-audit"] as const)
      it(`preserves captured contexts across ${host}/${entry}/${history}`,()=>runInterleavedHistory(host,entry,history));
  it("rejects wrong/missing/reordered late callbacks with the same assertions",async()=>{
    const result=await proveInterleavedGate();assert.deepStrictEqual(result.failures,[]);assert.equal(result.rejectingControls,result.plannedControls);
  });
}



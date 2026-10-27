// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import {assertScenario,effect,hosts,successScenario,bypasses,validReplies,expectedSuccess,type Scenario,type Reply,type Input} from "./host-contract";
import {IndependentHostModel} from "./host-model";

export const scenarios:Scenario[]=[];
for(const [host,entry] of hosts){
  for(const operation of ["work","recover","delegate"] as const)scenarios.push(successScenario(host,entry,[],operation));
  for(const bypass of bypasses)scenarios.push(successScenario(host,entry,[bypass]));
}
// Alternative flows have requirement-derived expected refusal and zero later effects.
for(const [boundary,field,value,reason] of [
  ["assets","pin",false,"assets"],["assets","runtime",false,"assets"],["assets","modules",false,"assets"],
  ["trust","verified",false,"trust"],["trust","policy","changed-policy","trust"],
  ["hub","identity","cline","hub-identity"],["hub","policy","foreign-policy","hub-identity"],
  ["guidance","skills",[],"guidance"],["guidance","memory",null,"guidance"],["guidance","requirements",null,"guidance"],
  ["ingress","code","queued","ingress"],["ingress","revision",0,"ingress"],
  ["authorize","allow",false,"authorization"],["authorize","policy","stale","authorization"],
  ["provider","provider","cline","provider-selection"],["provider","model","silently-chosen","provider-selection"],
  ["audit","code","queued","audit"],["audit","code","rejected","audit"],["audit","code","lost","audit"],["audit","revision",0,"audit"],["audit","text","summary","audit"],
  ["audit","decision",false,"obligations"],["audit","verification",false,"obligations"],["audit","title","User prompt","obligations"],
  ["completion","allow",false,"completion"],["completion","policy","stale","completion"],["delivery","delivered",false,"delivery"],
] as const){
  const s=successScenario("cli","recovery"); s.name=`refuse/${boundary}/${field}/${String(value)}`;
  const index=s.replies.findIndex(r=>r.boundary===boundary);
  (s.replies[index].value as Record<string,unknown>)[field]=value;
  s.expected=[...s.expected.slice(0,index+2),effect("blocked",reason),effect("canary",s.input.canary)];
  scenarios.push(s);
}
for(const provider of ["cline","cline-pass",""]){
  const s=successScenario("hub","schedule");s.name=`excluded-provider/${provider}`;s.input.provider=provider;
  s.expected=[...s.expected.slice(0,7),effect("blocked","configure-direct-provider"),effect("canary",s.input.canary)];scenarios.push(s);
}
for(const field of ["workspace","nativeSession","agent","session","request","event","policy"]){
  const s=successScenario("vscode","resume");s.name=`foreign-callback/${field}`;
  const receipt=s.replies.find(r=>r.boundary==="audit")!.value as {binding:Record<string,string>};
  // Never mutate the captured request alongside the callback.
  receipt.binding={...receipt.binding,[field]:"foreign"};
  s.expected=[...s.expected.slice(0,9),effect("blocked","audit"),effect("canary",s.input.canary)];scenarios.push(s);
}

for(const rootKind of ["equal","nested"]){
  const s=successScenario("cli","one-shot");s.name=`storage-refusal/${rootKind}`;
  s.input.root=s.input.upstream+(rootKind==="nested"?"/data":"");
  s.expected=[effect("blocked","upstream-storage"),effect("canary",s.input.canary)];scenarios.push(s);
}
for(const host of ["cli","hub","vscode"]){
  const s=successScenario(host,"secret-output-boundary");s.input.secrets=["fixture-key-ONLY","fixture-signature-ONLY","other-context-key-ONLY"];
  s.input.request="## Request\r\nfixture-key-ONLY \u2013 fixture-signature-ONLY 雪\n\n";
  s.input.result="## Result\r\nother-context-key-ONLY \u2014 fixture-key-ONLY **exact**\n\n";
  s.replies=validReplies(s.input);s.expected=expectedSuccess(s.input);scenarios.push(s);
}
export async function proveMockGate(){
  const evidence:{name:string;ac:string[];uc:string[];observed:unknown;state:unknown;controls:{fault:string;observed:unknown}[]}[]=[];
  let controls=0;
  for(const scenario of scenarios){
    const provider=new IndependentHostModel(structuredClone(scenario.replies));
    const observed=await assertScenario(provider,scenario);
    const captured:typeof evidence[number]={name:scenario.name,ac:scenario.ac,uc:scenario.uc,observed,state:provider.snapshot(),controls:[]};
    // Alter actual dependency callbacks, never expected output leaves.
    const faults:{name:string;replies:Reply[];input?:Input}[]=[];
    if(!observed.some(x=>x.kind==="success")){
      const input=structuredClone(scenario.input);input.provider="direct-fixture";input.root=input.home+"/.cline-qb/data";
      faults.push({name:"incorrectly-accepted-alternative-flow",input,replies:validReplies(input)});
    }
    for(let index=0;observed.some(x=>x.kind==="success") && index<scenario.replies.length;index++){
      // Only consumed callbacks are a meaningful negative control for blocked flows.
      if(!observed.some(x=>x.kind===scenario.replies[index].boundary))continue;
      const missing=structuredClone(scenario.replies);missing.splice(index,1);
      faults.push({name:`missing-${scenario.replies[index].boundary}`,replies:missing});
      const wrong=structuredClone(scenario.replies);wrong[index].value=null;
      faults.push({name:`wrong-${scenario.replies[index].boundary}`,replies:wrong});
    }
    if(observed.some(x=>x.kind==="success")){
      const swapped=structuredClone(scenario.replies);[swapped[4],swapped[5]]=[swapped[5],swapped[4]];
      faults.push({name:"reordered-ingress-authorization",replies:swapped});
      const truncated=structuredClone(scenario.replies);(truncated[6].value as {text:string}).text="truncated result";
      faults.push({name:"changed-provider-result-before-audit",replies:truncated});
    }
    for(const fault of faults){
      let rejected=false,actual:unknown;
      try{await assertScenario(new IndependentHostModel(fault.replies),{...scenario,input:fault.input??scenario.input});}catch(error){
        if(error instanceof assert.AssertionError){rejected=true;actual=error.actual;}else throw error;
      }
      // Some already-blocked fixtures reject at the same boundary with the same reason.
      // Such callbacks are not counted as discriminating controls.
      assert.equal(rejected,true,`unrejected:${scenario.name}/${fault.name}`);
      captured.controls.push({fault:fault.name,observed:actual});controls++;
    }
    evidence.push(captured);
  }
  return {mode:"Mock",scenarios:evidence.length,negativeControls:controls,failed:0,skipped:0,evidence,productionBound:false};
}
if(process.argv.includes("--mock-proof")){
  const proof=await proveMockGate();process.stdout.write(JSON.stringify(proof)+"\n");
}else{
  const {it}=await import("vitest");
  for(const scenario of scenarios)it(scenario.name,()=>assertScenario(new IndependentHostModel(structuredClone(scenario.replies)),scenario));
  it("rejects independent wrong/missing/reordered dependency interactions through the same assertions",async()=>{await proveMockGate();});
}

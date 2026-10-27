// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import {capturedBackgroundLaunch,rereadingBackgroundLaunch,type BackgroundContext,type BackgroundLaunch} from "./menubar-context.test-support";
import {ScriptedBackend,modelPort,actualTransportPort,type Fault,type PortFactory} from "./menubar-transport.test-support";
type Kind="unchanged"|"replace-context"|"mutate-context"|"identical-text";
const kinds:Kind[]=["unchanged","replace-context","mutate-context","identical-text"];
const faults:Fault[]=["wrong-start-session","wrong-send-session","changed-prompt","changed-result","omit-send","double-send","reorder-effects","missing-reply","swapped-reply"];
const clone=<T>(value:T):T=>JSON.parse(JSON.stringify(value));
export async function assertTransportScenario(kind:Kind,launch:BackgroundLaunch,factory:PortFactory=modelPort,fault:Fault="none"){
  const a:BackgroundContext={workspaceRoot:"/synthetic/workspace-a",cwd:"/synthetic/workspace-a/cwd",provider:"synthetic-provider-a",model:"synthetic-model-a"};
  const b:BackgroundContext=kind==="unchanged"?clone(a):{workspaceRoot:"/synthetic/workspace-b",cwd:"/synthetic/workspace-b/cwd",provider:"synthetic-provider-b",model:"synthetic-model-b"};
  const originalA=clone(a),originalB=clone(b);
  const firstPrompt="  # A\r\n\u96ea\n  ",secondPrompt=kind==="identical-text"?firstPrompt:"  # B\r\nsecond\n  ";
  let current=a;
  const backend=new ScriptedBackend(fault),port=await factory(backend);
  const notifications:string[]=[],calls:unknown[]=[],observedResults:unknown[]=[];
  const dependencies={
    context:()=>current,
    auth:(provider:string)=>({apiKey:`synthetic-key-for-${provider}`}),
    start:async(input:Parameters<typeof port.start>[0])=>{calls.push({operation:"start",input:clone(input)});return port.start(input);},
    send:async(sessionId:string,input:Parameters<typeof port.send>[1])=>{
      calls.push({operation:"send",sessionId,input:clone(input)});
      const result=await port.send(sessionId,input);observedResults.push(clone(result));
    },
    notify:(body:string)=>{notifications.push(body);},
  };
  const snapshot=()=>({kind,fault,frames:clone(backend.frames),sessions:Array.from(backend.sessions),effects:clone(backend.effects),results:clone(observedResults),replies:clone(backend.replies),calls:clone(calls),notifications:clone(notifications)});
  try{
    const first=launch(firstPrompt,dependencies);
    await backend.firstWaiting.promise;
    if(kind==="mutate-context")Object.assign(current,b);else current=b;
    const second=launch(secondPrompt,dependencies);
    await backend.creates[1]!.promise;
    await second;
    const whileFirstHeld=snapshot();
    backend.releaseFirst.resolve();
    await first;
    const expectedState=(context:BackgroundContext)=>({...context,apiKey:`synthetic-key-for-${context.provider}`});
    const effect=(context:BackgroundContext,sessionId:string,prompt:string)=>({...expectedState(context),sessionId,prompt:prompt.trim()});
    const expectedB=effect(originalB,"synthetic-session-2",secondPrompt),expectedA=effect(originalA,"synthetic-session-1",firstPrompt);
    assert.deepStrictEqual(notifications,[],"No launch should fail under the correct script");
    assert.deepStrictEqual(whileFirstHeld.effects,[expectedB],"B completes independently while A waits");
    assert.deepStrictEqual(backend.effects,[expectedB,expectedA],"Actual recorded execution effects retain started session identity");
    assert.deepStrictEqual(Array.from(backend.sessions),[["synthetic-session-1",expectedState(originalA)],["synthetic-session-2",expectedState(originalB)]],"Backend state is allocated from original start inputs");
    assert.deepStrictEqual(observedResults,[{result:expectedB},{result:expectedA}],"Replies return exact per-session scripted results");
    const frames=backend.frames.filter(frame=>frame.command!=="client.register");
    assert.deepStrictEqual(frames.map(frame=>[frame.command,frame.sessionId??null]),[
      ["session.create",null],["session.create",null],["session.send_input","synthetic-session-2"],["session.send_input","synthetic-session-1"],
    ],"Actual serialized operation order and send targets");
    assert.deepStrictEqual(frames.slice(2).map(frame=>frame.payload),[{prompt:secondPrompt.trim()},{prompt:firstPrompt.trim()}],"Transport sends execution text only and does not rebind start configuration");
    assert.equal(backend.frames.filter(frame=>frame.command==="client.register").length,1,"One client registration");
    assert.equal(new Set(backend.frames.map(frame=>frame.requestId)).size,backend.frames.length,"Each actual command has a distinct request ID");
    assert.deepStrictEqual(backend.replies.map(reply=>reply.requestId).sort(),frames.map(frame=>frame.requestId).sort(),"Every command has its own captured reply");
    for(let i=0;i<2;i++){
      const context=i===0?originalA:originalB,config=frames[i]!.payload.sessionConfig as Record<string,unknown>;
      assert.deepStrictEqual({workspaceRoot:config.workspaceRoot,cwd:config.cwd,provider:config.providerId,model:config.modelId,apiKey:config.apiKey},expectedState(context),"Start serializes the original context");
    }
    return {...snapshot(),whileFirstHeld,expectedExecutionEquivalent:true};
  }catch(error){
    if(error instanceof assert.AssertionError)(error as assert.AssertionError & {interactionEvidence:unknown}).interactionEvidence=snapshot();
    throw error;
  }finally{backend.releaseFirst.resolve();port.close();}
}
export async function proveTransportGate(factory:PortFactory=modelPort,actualTransportBound=false){
  const evidence:unknown[]=[],failures:Array<{name:string;error:string}>=[];let passed=0,rejected=0,planned=0;
  const callers=[["original-source-faithful-model",rereadingBackgroundLaunch],["captured-context-model",capturedBackgroundLaunch]] as const;
  for(const [caller,launch] of callers)for(const kind of kinds){
    try{evidence.push({caller,observed:await assertTransportScenario(kind,launch,factory)});passed++;}
    catch(error){failures.push({name:`${caller}/${kind}`,error:String(error)});}
    for(const fault of faults){
      planned++;let caught=false;
      try{await assertTransportScenario(kind,launch,modelPort,fault);}
      catch(error){if(error instanceof assert.AssertionError){caught=true;rejected++;evidence.push({caller,kind,fault,rejected:true,interactionEvidence:(error as assert.AssertionError & {interactionEvidence:unknown}).interactionEvidence});}else failures.push({name:`${caller}/${kind}/${fault}`,error:`Wrong exception: ${String(error)}`});}
      if(!caught)failures.push({name:`${caller}/${kind}/${fault}`,error:"Incorrect transport effect/response accepted"});
    }
  }
  return {mode:actualTransportBound?"Actual baseline client with scripted WebSocket":"Independent transport model",scenarios:8,passed,plannedControls:planned,rejectingControls:rejected,failed:failures.length,skipped:0,failures,evidence,actualTransportBound,actualNativeHost:false,actualProvider:false,governedIntegration:false,originalCallerIsSourceFaithfulModel:true};
}
if(process.argv.includes("--mock-proof")||process.argv.includes("--transport-proof")){
  const actual=process.argv.includes("--transport-proof");
  const result=await proveTransportGate(actual?actualTransportPort:modelPort,actual);
  console.log(JSON.stringify(result));if(result.failed)process.exitCode=1;
}else{
  const {it}=await import("vitest");
  it("proves original session transport effects under deferred context changes with independent rejecting controls",async()=>{
    const result=await proveTransportGate();assert.deepStrictEqual(result.failures,[]);assert.equal(result.passed,8);assert.equal(result.rejectingControls,72);
  });
  it("binds the SAME execution/session assertions to the baseline public client and scripted WebSocket",async()=>{
    const result=await proveTransportGate(actualTransportPort,true);assert.deepStrictEqual(result.failures,[]);assert.equal(result.passed,8);assert.equal(result.rejectingControls,72);
  });
}

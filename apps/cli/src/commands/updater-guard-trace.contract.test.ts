// SPDX-License-Identifier: Apache-2.0
import { strict as assert, AssertionError } from "node:assert";
import { describe, expect, it } from "vitest";
import { createUpdaterGuardTrace } from "./updater-guard-trace.test-support";
type Fault = "none" | "this" | "args" | "double" | "return" | "error" | "order";
function observe(throws: boolean, sinkThrows: boolean, fault: Fault) {
  const receiver={id:"synthetic receiver"};const first={id:"input"};const second=["argument"];
  const returned={id:"scripted result"};const failure=Object.assign(new Error("QB blocked native fixture"),{code:"SYNTHETIC_BLOCK"});
  const calls: {receiver:unknown;args:unknown[]}[]=[];
  const events:{phase:string;operation:string;stack:string;errorCode?:string}[]=[]; const timeline:string[]=[];
  const trace=createUpdaterGuardTrace(entry=>{timeline.push(entry.event.phase);events.push({...entry.event,stack:entry.stack});if(sinkThrows)throw new Error("synthetic trace sink failure");});
  const original=function(this:unknown,...args:unknown[]){timeline.push("call");calls.push({receiver:this,args});if(throws)throw failure;return returned;};
  const wrapped=trace.wrap("guard.execFileSync",original);
  const exercised=function(this:unknown,...args:unknown[]){
    if(fault==="order"){let value:unknown,caught:unknown;try{value=Reflect.apply(original,this,args);}catch(error){caught=error;}const late=trace.wrap("guard.execFileSync",function(){if(throws)throw caught;return value;});return Reflect.apply(late,this,args);}
    if(fault==="double")Reflect.apply(wrapped,this,args);
    try {const result=Reflect.apply(wrapped,fault==="this"?undefined:this,fault==="args"?[]:args);return fault==="return"?{}:result;}
    catch(error){if(fault==="error")return undefined;throw error;}
  };
  let result:unknown,error:unknown;
  try{result=Reflect.apply(exercised,receiver,[first,second]);}catch(caught){error=caught;}

  return {timeline,receiver,first,second,returned,failure,calls,events,result,error,sinkFailures:trace.failures,throws,sinkThrows};
}
function assertObserved(o:ReturnType<typeof observe>){
  assert.equal(o.calls.length,1);assert.equal(o.calls[0]!.receiver,o.receiver);
  assert.equal(o.calls[0]!.args.length,2);assert.equal(o.calls[0]!.args[0],o.first);assert.equal(o.calls[0]!.args[1],o.second);
  assert.equal(o.result,o.throws?undefined:o.returned);assert.equal(o.error,o.throws?o.failure:undefined);
  assert.deepEqual(o.events.map(e=>({operation:e.operation,phase:e.phase,errorCode:e.errorCode})),[
    {operation:"guard.execFileSync",phase:"before",errorCode:undefined},
    {operation:"guard.execFileSync",phase:o.throws?"error":"after",errorCode:o.throws?"SYNTHETIC_BLOCK":undefined},
  ]);
  for(const e of o.events){assert.ok(e.stack.includes("C updater guard callsite"));assert.ok(e.stack.includes("updater-guard-trace.contract.test.ts"));}
  assert.equal(o.sinkFailures.length,o.sinkThrows?2:0);
  assert.deepEqual(o.timeline,["before","call",o.throws?"error":"after"]);
}
describe("updater rejecting guard diagnostic exact forwarding",()=>{
  for(const throws of [false,true])for(const sinkThrows of [false,true])it(`preserves throws=${throws}/sinkThrows=${sinkThrows}`,()=>assertObserved(observe(throws,sinkThrows,"none")));
  for(const [throws,fault] of [[false,"this"],[false,"args"],[false,"double"],[false,"return"],[true,"error"],[false,"order"],[true,"order"]] as const)
    it(`rejects executed ${fault}/${throws} through SAME assertions`,()=>{let error:unknown;try{assertObserved(observe(throws,false,fault));}catch(e){error=e;}expect(error).toBeInstanceOf(AssertionError);});
});


// SPDX-License-Identifier: Apache-2.0
import { strict as assert, AssertionError } from "node:assert";
import type { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createKanbanCommandModel, type KanbanFixtureStep } from "./kanban-process.test-support";
const roots:string[]=[];afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
type Fault="none"|"wrong-exit"|"missing-write"|"wrong-file"|"wrong-bytes"|"missing-register"|"early-close"|"double-close"|"missing-close"|"error";
async function observe(install:boolean,fault:Fault){
 const root=mkdtempSync(join(tmpdir(),"c-kanban-model-"));roots.push(root);
 const model=createKanbanCommandModel();const file=join(root,"kanban.cmd");const delegated:unknown[][]=[];
 const delegate=((...args:unknown[])=>{delegated.push(args);throw new Error("Unexpected native command");}) as typeof spawn;
 const run=model.wrap(delegate,"win32");
 const terminal:KanbanFixtureStep={kind:"close",code:fault==="wrong-exit"?9:install?6:7};
 const installed:KanbanFixtureStep[]=[terminal];
 let steps:KanbanFixtureStep[]=install?[
  {kind:"write",path:fault==="wrong-file"?join(root,"other.cmd"):file,content:fault==="wrong-bytes"?"changed":"synthetic-command"},
  {kind:"register",command:"kanban.cmd",steps:installed},
  {kind:"close",code:0},
 ]:[terminal];
 if(fault==="missing-write")steps=steps.filter(s=>s.kind!=="write");
 if(fault==="missing-register")steps=steps.filter(s=>s.kind!=="register");
 if(fault==="early-close")steps=[steps.at(-1)!,...steps.slice(0,-1)];
 if(fault==="double-close")steps=[...steps,steps.at(-1)!];
 if(fault==="missing-close")steps=steps.filter(s=>s.kind!=="close");
 if(fault==="error")steps=[{kind:"error",message:"scripted failure"}];
 model.register(install?"npm.cmd":"kanban.cmd",root,steps);
 const callbacks:Record<string,unknown>[]=[];
 const invoke=async(command:string,args:string[])=>{let exit:number|null|undefined;const child=run(command,args,{shell:true,detached:false,stdio:"inherit"});child.on("close",(code,signal)=>{callbacks.push({kind:"close",command,code,signal});exit=code;});child.on("error",error=>callbacks.push({kind:"error",command,message:String(error)}));await new Promise<void>(resolve=>queueMicrotask(resolve));return exit;};
 const installer=install?await invoke("npm.cmd",["install","-g","kanban@latest"]):undefined;
 let result:number|null|undefined,error:unknown;
 try {if(!install || installer===0)result=await invoke("kanban.cmd",[]);}catch(e){error=e;}
 let bytes:string|undefined;try{bytes=readFileSync(file,"utf8");}catch{}
 return {root,file,install,installer,result,error,bytes,callbacks,effects:model.effects,delegated};
}
function assertObserved(o:Awaited<ReturnType<typeof observe>>){
 assert.equal(o.result,o.install?6:7);assert.equal(o.installer,o.install?0:undefined);assert.equal(o.error,undefined);assert.deepEqual(o.delegated,[]);
 const spawn=(command:string,args:string[])=>({kind:"spawn",command,args,shell:true,detached:false,stdio:"inherit"});
 const close=(command:string,code:number)=>({kind:"close",command,code});
 assert.deepEqual(o.effects,o.install?[spawn("npm.cmd",["install","-g","kanban@latest"]),{kind:"write",path:o.file,content:"synthetic-command"},{kind:"register",command:"kanban.cmd"},close("npm.cmd",0),spawn("kanban.cmd",[]),close("kanban.cmd",6)]:[spawn("kanban.cmd",[]),close("kanban.cmd",7)]);
 assert.deepEqual(o.callbacks,o.install?[{...close("npm.cmd",0),signal:null},{...close("kanban.cmd",6),signal:null}]:[{...close("kanban.cmd",7),signal:null}]);
 assert.equal(o.bytes,o.install?"synthetic-command":undefined);
}
describe("original kanban Windows executable fixture prerequisite",()=>{
 for(const install of [false,true])it(`correct install=${install}`,async()=>{const observed=await observe(install,"none");assertObserved(observed);console.log("C_KANBAN_FIXTURE "+JSON.stringify(observed));});
 for(const [install,fault] of [[false,"wrong-exit"],[false,"double-close"],[false,"missing-close"],[false,"error"],[true,"wrong-exit"],[true,"missing-write"],[true,"wrong-file"],[true,"wrong-bytes"],[true,"missing-register"],[true,"early-close"],[true,"double-close"],[true,"missing-close"],[true,"error"]] as const)it(`rejects executed ${install}/${fault}`,async()=>{let error:unknown;try{assertObserved(await observe(install,fault));}catch(e){error=e;}expect(error).toBeInstanceOf(AssertionError);});
});
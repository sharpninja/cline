// SPDX-License-Identifier: Apache-2.0
// Existing wrapper executes inside an isolated VM; the callee is an input-only program model.
import { strict as assert, AssertionError } from "node:assert";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
const source=readFileSync(fileURLToPath(new URL("../../bin/cline",import.meta.url)),"utf8");
class Exit { constructor(readonly code:number){} }
type Fault="none"|"missing-program"|"wrong-code"|"wrong-wrapper"|"omit-script"|"double";
function observe(platform:"win32"|"linux",kind:"exit"|"wrapper",fault:Fault){
  const paths=platform==="win32"?path.win32:path.posix;
  const root=platform==="win32"?"F:\\synthetic-c-wrapper":"/synthetic-c-wrapper";
  const wrapper=paths.join(root,"bin","cline"),script=paths.join(root,"child.js"),node=paths.join(root,platform==="win32"?"node.exe":"node");
  const binary=platform==="win32"?node:script;
  const childArgs=platform==="win32"?[script,...(kind==="exit"?["7"]:[])]:kind==="exit"?["7"]:[];
  if(fault==="omit-script"&&platform==="win32")childArgs.shift();
  const calls:{target:string;args:string[];stdio:unknown;env:Record<string,string>}[]=[];
  let stdout="",status:number|undefined;const errors:string[]=[];
  // Scripted executable state owns its program lookup and interprets received args/env.
  const programs=new Map(fault==="missing-program"?[]:[[script,kind]] as [string,"exit"|"wrapper"][]);
  const spawnSync=(target:string,args:string[],options:{stdio:unknown;env:Record<string,string>})=>{
    calls.push({target,args:[...args],stdio:options.stdio,env:{...options.env}});
    const executableScript=target===node?args[0]:target;
    const argv=target===node?args.slice(1):args;
    const program=programs.get(executableScript??"");
    if(!program)return{status:null,signal:null,error:Object.assign(new Error("fixture executable/program missing"),{code:"ENOENT"})};
    if(program==="wrapper")stdout+=(fault==="wrong-wrapper"?"other":options.env.CLINE_WRAPPER_PATH??"")+"\n";
    return{status:fault==="wrong-code"?19:program==="exit"?Number(argv[0]??"0"):0,signal:null};
  };
  const context={__filename:wrapper,process:{argv:[node,wrapper,...childArgs],env:{CLINE_BIN_PATH:binary},versions:{node:"26.4.0"},exit:(code:number)=>{throw new Exit(code);}},console:{error:(...args:unknown[])=>errors.push(args.map(String).join(" ")),warn:()=>{}},require:(name:string)=>{
    if(name==="child_process")return{spawnSync};if(name==="fs")return{realpathSync:(value:string)=>value,existsSync:()=>false};if(name==="path")return paths;if(name==="os")return{platform:()=>platform,arch:()=>"x64"};throw new Error("fixture has no CA module or external dependency");
  }};
  for(let count=0;count<(fault==="double"?2:1);count++)try{runInNewContext(source,{...context},{filename:"C-existing-wrapper-fixture.js"});}catch(error){if(error instanceof Exit)status=error.code;else throw error;}
  const result={platform,kind,fault,wrapper,binary,script,calls,stdout,status,errors,childArgs};
  console.log("C_WRAPPER_FIXTURE "+JSON.stringify(result));return result;
}
function assertObserved(o:ReturnType<typeof observe>){
  assert.equal(o.calls.length,1);assert.equal(o.calls[0]!.target,o.binary);assert.deepEqual(o.calls[0]!.args,o.childArgs);
  assert.equal(o.calls[0]!.stdio,"inherit");assert.equal(o.calls[0]!.env.CLINE_WRAPPER_PATH,o.wrapper);assert.deepEqual(o.errors,[]);
  assert.equal(o.status,o.kind==="exit"?7:0);
  if(o.kind==="wrapper")assert.match(o.stdout.trim(),/bin[/\\]cline$/);
}
describe("original wrapper fixture native executable contract",()=>{
  for(const platform of ["win32","linux"] as const)for(const kind of ["exit","wrapper"] as const)it(`${platform}/${kind} forwards original inputs`,()=>assertObserved(observe(platform,kind,"none")));
  for(const [platform,kind,fault] of [["win32","exit","missing-program"],["linux","exit","wrong-code"],["win32","wrapper","wrong-wrapper"],["win32","exit","omit-script"],["win32","exit","double"],["linux","wrapper","double"]] as const)
    it(`${platform}/${kind} rejects executed ${fault}`,()=>{let error:unknown;try{assertObserved(observe(platform,kind,fault));}catch(caught){error=caught;}expect(error).toBeInstanceOf(AssertionError);});
});

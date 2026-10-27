// SPDX-License-Identifier: Apache-2.0
// Registered task-owned Windows command programs only. Native commands are delegated.
import type { spawn as nativeSpawn, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";
export type KanbanFixtureStep =
 | {kind:"write";path:string;content:string}
 | {kind:"register";command:string;steps:KanbanFixtureStep[]}
 | {kind:"close";code:number}
 | {kind:"error";message:string};
export function createKanbanCommandModel() {
 const programs=new Map<string,{root:string;steps:KanbanFixtureStep[]}>();
 const effects: Record<string,unknown>[]=[];
 function register(command:string,root:string,steps:KanbanFixtureStep[]){programs.set(command,{root:resolve(root),steps:structuredClone(steps)});}
 function wrap(realSpawn:typeof nativeSpawn,platform:NodeJS.Platform=process.platform):typeof nativeSpawn {
  return ((command:string,args:readonly string[]=[],options:SpawnOptions={})=>{
   const program=programs.get(command);
   if(platform!=="win32" || !program)return realSpawn(command,[...args],options);
   const child=new EventEmitter() as EventEmitter & {kill:()=>boolean};child.kill=()=>false;
   effects.push({kind:"spawn",command,args:[...args],shell:options.shell,detached:options.detached,stdio:options.stdio});
   queueMicrotask(()=>{
    try {for(const step of program.steps){
     if(step.kind==="write") {const target=resolve(step.path);if(!target.startsWith(program.root+sep))throw new Error("Synthetic command write escaped registered root");writeFileSync(target,step.content);effects.push({kind:"write",path:target,content:step.content});}
     if(step.kind==="register"){register(step.command,program.root,step.steps);effects.push({kind:"register",command:step.command});}
     if(step.kind==="close"){effects.push({kind:"close",command,code:step.code});child.emit("close",step.code,null);}
     if(step.kind==="error"){effects.push({kind:"error",command,message:step.message});child.emit("error",new Error(step.message));}
    }}catch(error){effects.push({kind:"error",command,message:String(error)});child.emit("error",error);}
   });
   return child as unknown as ReturnType<typeof nativeSpawn>;
  }) as typeof nativeSpawn;
 }
 return {register,wrap,effects,reset(){programs.clear();effects.length=0;}};
}
const active=createKanbanCommandModel();
export const registerKanbanCommand=active.register;
export const resetKanbanCommands=active.reset;
export const kanbanCommandEffects=active.effects;
export const withKanbanCommandFixtures=active.wrap;
// SPDX-License-Identifier: Apache-2.0
// Mock prerequisite for native-path fixture expectations in the original five files.
// This is modeled path syntax, not Linux/native host acceptance.
import { strict as assert, AssertionError } from "node:assert";
import { posix, win32 } from "node:path";
import { describe, it, expect } from "vitest";
type Operation = "dashboard" | "connector" | "owner" | "image" | "opener";
type Fault = "none" | "root" | "name" | "omitted" | "duplicate";
// Input-only model owns emitted calls and storage. No expected values are supplied.
function execute(style: "windows" | "posix", operation: Operation, fault: Fault) {
 const path = style === "windows" ? win32 : posix;
 const root = style === "windows" ? "F:\\synthetic-c" : "/synthetic-c";
 const actualRoot = fault === "root" ? path.join(root,"other") : root;
 const calls: { operation: string; path: string; data?: string }[] = [];
 const files = new Map<string,string>();
 let value="";
 const record=(name:string, file:string, data?:string)=>{
  if(fault === "omitted")return;
  calls.push({operation:name,path:file,...(data===undefined?{}:{data})});
  if(fault === "duplicate")calls.push({operation:name,path:file,...(data===undefined?{}:{data})});
 };
 if(operation === "dashboard") { value=path.resolve(actualRoot,"state");record("set-env",value); }
 if(operation === "connector") { value=path.join(actualRoot,"logs","connectors","test",fault==="name"?"other.log":"test-connector.log");record("spawn-log",value); }
 if(operation === "owner") { value=path.join(actualRoot,"locks","hub",fault==="name"?"other":"owners","identity.json");record("owner-read",value); }
 if(operation === "image") { value=path.join(actualRoot,fault==="name"?"other.png":"generated.png");files.set(value,"original-image-bytes");record("write",value,"original-image-bytes"); }
 if(operation === "opener") { const entries=[path.join(actualRoot,"local"),path.join(actualRoot,"bin")];const executable=path.join(entries[1]!,fault==="name"?"other":"xdg-open");files.set(executable,"executable");const envPath=entries.join(path.delimiter);for(const entry of envPath.split(path.delimiter)){const candidate=path.join(entry,"xdg-open");record("access",candidate);if(files.has(candidate)){value=candidate;record("open",candidate);break;}} }
 return {style,operation,root,calls,files,value};
}
// Assertions preserve path components/boundaries and exact bytes/call effects.
function assertObserved(o:ReturnType<typeof execute>) {
 const path=o.style==="windows"?win32:posix;
 const root=o.style==="windows"?"F:\\synthetic-c":"/synthetic-c";
 const p=(...parts:string[])=>path.join(root,...parts);
 if(o.operation==="dashboard") {assert.equal(o.value,path.resolve(root,"state"));assert.deepEqual(o.calls,[{operation:"set-env",path:path.resolve(root,"state")}]);}
 if(o.operation==="connector") {assert.ok(o.value.includes(path.join("logs","connectors","test","test-connector.log")));assert.deepEqual(o.calls,[{operation:"spawn-log",path:p("logs","connectors","test","test-connector.log")}]);}
 if(o.operation==="owner") {assert.ok(o.value.includes(path.sep+path.join("locks","hub","owners")+path.sep));assert.deepEqual(o.calls,[{operation:"owner-read",path:p("locks","hub","owners","identity.json")}]);}
 if(o.operation==="image") {const suffix=path.sep+"generated.png";const output="[generated image] "+o.value;const end=output.indexOf(suffix);const start=output.lastIndexOf(" ",end);const file=end>=0?output.slice(start+1,end+suffix.length):undefined;assert.notEqual(file,undefined);assert.equal(o.files.get(file!),"original-image-bytes");assert.deepEqual(o.calls,[{operation:"write",path:p("generated.png"),data:"original-image-bytes"}]);}
 if(o.operation==="opener") {assert.equal(o.value,p("bin","xdg-open"));assert.deepEqual(o.calls,[{operation:"access",path:p("local","xdg-open")},{operation:"access",path:p("bin","xdg-open")},{operation:"open",path:p("bin","xdg-open")}]);}
}
describe("original failure native fixture expectations",()=>{
 for(const style of ["windows","posix"] as const)for(const operation of ["dashboard","connector","owner","image","opener"] as const){
  it(`${style}/${operation} correct`,()=>{const observed=execute(style,operation,"none");assertObserved(observed);console.log("C_NATIVE_PATH_FIXTURE "+JSON.stringify({...observed,files:[...observed.files]}));});
  for(const fault of ["root","omitted","duplicate",...(operation==="dashboard"?[]:["name"])] as Fault[])it(`${style}/${operation} rejects executed ${fault}`,()=>{let error:unknown;try{assertObserved(execute(style,operation,fault));}catch(e){error=e;}expect(error).toBeInstanceOf(AssertionError);});
 }
});
// SPDX-License-Identifier: Apache-2.0
import { strict as assert, AssertionError } from "node:assert";
export type Style = "windows" | "posix";
type Kind = "primary" | "sdk" | "explicit" | "missing";
type Fault = "none" | "wrong-root" | "omit-lookup" | "duplicate-lookup" | "reverse-lookup" | "changed-launcher" | "changed-cwd" | "false-exists" | "forbidden-lookup" | "false-found";
type Input = { style: Style; root: string; execPath: string; env: Record<string,string>; files: string[] };
type Launch = { launcher: string; connectArgsPrefix: string[]; cwd: string };
export type Port = (input: Input) => Promise<{result: Launch; calls: string[]}>;
const fixtures = (style: Style) => {
 const primary = style === "windows" ? "\\repo\\apps\\cli\\src\\index.ts" : "/repo/apps/cli/src/index.ts";
 const sdk = style === "windows" ? "\\repo\\sdk\\apps\\cli\\src\\index.ts" : "/repo/sdk/apps/cli/src/index.ts";
 return {primary,sdk};
};
// The model receives only operation inputs and a fault. It owns lookup state and effects.
// Its path construction is independent of production node:path join/normalize.
export function modelPort(fault: Fault): Port {
 return async input => {
  const calls: string[] = [];
  const exists = (candidate: string) => {
   if(fault !== "omit-lookup") calls.push(candidate);
   if(fault === "duplicate-lookup") calls.push(candidate);
   return fault === "false-exists" ? false : fault === "false-found" ? true : input.files.includes(candidate);
  };
  let result: Launch;
  if(input.env.CLINE_CLI_PATH?.trim()) {
   if(fault === "forbidden-lookup") exists("forbidden-lookup");
   result={launcher:input.env.CLINE_CLI_PATH.trim(),connectArgsPrefix:["connect"],cwd:input.root};
  } else {
   const sep=input.style === "windows" ? "\\" : "/";
   const root=(fault === "wrong-root" ? "/other" : input.root).replaceAll("\\","/").split("/").filter(Boolean).join(sep);
   let candidates=[sep+root+sep+"apps"+sep+"cli"+sep+"src"+sep+"index.ts",sep+root+sep+"sdk"+sep+"apps"+sep+"cli"+sep+"src"+sep+"index.ts"];
   if(fault === "reverse-lookup") candidates=candidates.reverse();
   const found=candidates.find(exists);
   result=found ? {launcher:input.execPath.split(/[\\/]/).at(-1)!.toLowerCase().includes("bun")?input.execPath:"bun",connectArgsPrefix:["--conditions=development",found,"connect"],cwd:input.root} : {launcher:"cline",connectArgsPrefix:["connect"],cwd:input.root};
  }
  if(fault === "changed-launcher") result={...result,launcher:"wrong-launcher"};
  if(fault === "changed-cwd") result={...result,cwd:"/other"};
  return {result,calls};
 };
}
export function scenario(style: Style,kind: Kind) {
 const f=fixtures(style);
 const input: Input={style,root:"/repo",execPath:"/usr/local/bin/bun",env:kind === "explicit"?{CLINE_CLI_PATH:"/synthetic/installed/cline"}:{},files:kind === "primary"?[f.primary]:kind === "sdk"?[f.sdk]:[]};
 const expected: Launch=kind === "explicit" ? {launcher:"/synthetic/installed/cline",connectArgsPrefix:["connect"],cwd:"/repo"} : kind === "missing" ? {launcher:"cline",connectArgsPrefix:["connect"],cwd:"/repo"} : {launcher:"/usr/local/bin/bun",connectArgsPrefix:["--conditions=development",kind === "primary"?f.primary:f.sdk,"connect"],cwd:"/repo"};
 const expectedCalls=kind === "explicit"?[]:kind === "primary"?[f.primary]:[f.primary,f.sdk];
 return {style,kind,input,expected,expectedCalls};
}
export async function assertScenario(s: ReturnType<typeof scenario>,port: Port) {
 const observed=await port(s.input);
 assert.deepEqual(observed.result,s.expected);
 assert.deepEqual(observed.calls,s.expectedCalls);
 return {style:s.style,kind:s.kind,...observed};
}
export async function proveFixtureGate(actual?: Port,actualStyle?: Style) {
 const evidence: unknown[]=[];let positive=0;let rejectingControls=0;
 for(const style of ["windows","posix"] as const)for(const kind of ["primary","sdk","explicit","missing"] as const){
  const s=scenario(style,kind);evidence.push(await assertScenario(s,modelPort("none")));positive++;
  const faults: Fault[]=kind === "explicit"?["forbidden-lookup","changed-launcher","changed-cwd"]:kind === "missing"?["omit-lookup","duplicate-lookup","false-found","changed-cwd"]:["wrong-root","omit-lookup","duplicate-lookup","reverse-lookup","changed-launcher","changed-cwd","false-exists"];
  for(const fault of faults){let error: unknown;let observed: unknown;const port=modelPort(fault);try{await assertScenario(s,async input=>{const result=await port(input);observed=result;return result;});}catch(e){error=e;}assert.ok(error instanceof AssertionError,`${style}/${kind}/${fault} must fail intended assertion`);evidence.push({style,kind,fault,observed,rejected:true});rejectingControls++;}
 }
 const production: unknown[]=[];
 if(actual){assert.ok(actualStyle);for(const kind of ["primary","sdk","explicit","missing"] as const)production.push(await assertScenario(scenario(actualStyle!,kind),actual));}
 return {modelPositive:positive,rejectingControls,failed:0,skipped:0,actualPublicFunction:production.length,actualNativeHost:false,actualLinux:false,evidence,production};
}

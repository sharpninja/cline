// SPDX-License-Identifier: Apache-2.0
// Existing Windows-first host construction/fixture parity, FR-QB-002 and TEST-QB-005.
// Model path syntax is not Linux/native host or governed startup acceptance.
import { proveFixtureGate, type Port } from "./connector-launch-fixture.test-support";
async function actualPort(): Promise<Port> {
 const {resolveMenubarConnectorCliLaunchSpec}=await import("./connector-cli-launch");
 return async input=>{
  const calls: string[]=[];
  const result=resolveMenubarConnectorCliLaunchSpec(input.root,{env:input.env,execPath:input.execPath,exists:path=>{calls.push(path);return input.files.includes(path);}});
  return {result,calls};
 };
}
export async function runFixtureProof(mode: "Mock"|"Production") {
 const result=await proveFixtureGate(mode === "Production"?await actualPort():undefined,process.platform === "win32"?"windows":"posix");
 console.log(JSON.stringify({mode,...result}));return result;
}
if(import.meta.main){await runFixtureProof(process.argv.includes("--production-proof")?"Production":"Mock");}else{
 const {describe,it}=await import("vitest");
 describe("menubar connector native fixture parity",()=>{
  it("proves exact launch/lookup assertions with input-only mocks and rejecting interactions",async()=>{await runFixtureProof("Mock");});
  it("binds SAME assertions to the isolated original public resolver",async()=>{await runFixtureProof("Production");});
 });
}

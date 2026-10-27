// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { resolve, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { effect, hosts, successScenario, type Scenario } from "./host-contract";
import { FilesystemHostModel } from "./isolation-model.test-support";
import { assertIsolatedHost, type IsolationEvidence } from "./isolation-contract.test-support";
import { faults } from "./isolation-fixture.test-support";

export function isolationCases():Scenario[] {
  const cases=hosts.map(([host,entry])=>successScenario(host,entry));
  // These are scripted outcomes, not actual process timeout/cancellation acceptance.
  for(const reason of ["scripted-failure","scripted-timeout","scripted-cancellation"]) {
    const s=successScenario("cli","recovery"); s.name=`isolation/${reason}`;
    const index=s.replies.findIndex(r=>r.boundary==="provider");
    s.replies[index].value=new Error(reason);
    s.expected=[...s.expected.slice(0,index+2),effect("blocked",reason),effect("canary",s.input.canary)];
    cases.push(s);
  }
  return cases;
}
export async function proveIsolationGate(parent:string) {
  const evidence:IsolationEvidence[]=[], failures:{name:string;error:string}[]=[];
  let passed=0,controls=0;
  // Factory below deliberately excludes scenario/expectation objects.
  // Explicit factory gets only dependency script and captured boundary, never expected values.
  const provider=(script:ConstructorParameters<typeof FilesystemHostModel>[0],io:ConstructorParameters<typeof FilesystemHostModel>[1])=>new FilesystemHostModel(script,io);
  const cases=isolationCases();
  for(const scenario of cases) {
    try { await assertIsolatedHost(provider,scenario,parent,"none",e=>evidence.push(e)); passed++; }
    catch(error) { failures.push({name:scenario.name,error:String(error)}); }
    if(!scenario.expected.some(e=>e.kind==="success")) continue;
    for(const fault of faults) {
      let rejected=false;
      try { await assertIsolatedHost(provider,scenario,parent,fault,e=>evidence.push(e)); }
      catch(error) {
        if(error instanceof assert.AssertionError) rejected=true;
        else failures.push({name:`${scenario.name}/${fault}`,error:`Non-assertion exception: ${String(error)}`});
      }
      if(rejected) controls++;
      else failures.push({name:`${scenario.name}/${fault}`,error:"Required incorrect interaction was accepted"});
    }
  }
  return {mode:"Mock",scenarios:cases.length,passed,plannedControls:cases.filter(s=>s.expected.some(e=>e.kind==="success")).length*faults.length,rejectingControls:controls,failed:failures.length,skipped:0,failures,evidence,productionBound:false,actualGovernedHost:false,actualProvider:false,actualProcessCancellation:false};
}
if(process.argv.includes("--isolation-proof")) {
  const parent=process.argv[process.argv.indexOf("--isolation-proof")+1];
  assert.ok(parent && resolve(parent)===parent,"explicit absolute task-owned fixture parent required");
  const proof=await proveIsolationGate(parent); process.stdout.write(JSON.stringify(proof)+"\n");
  process.exitCode=proof.failed===0 ? 0 : 1;
} else {
  const {it}=await import("vitest");
  it("observes synthetic external state and rejects actual forbidden interactions through the SAME host assertions",async()=>{
    // A full-suite caller gets a unique task-owned temporary fixture, never a home/provider fallback.
    const parent=process.env.CLINE_C_ISOLATION_FIXTURE_ROOT ?? mkdtempSync(join(tmpdir(),"cline-c-isolation-suite-"));
    const proof=await proveIsolationGate(parent);
    assert.deepStrictEqual(proof.failures,[]); assert.equal(proof.passed,32);assert.equal(proof.rejectingControls,580);
  });
}

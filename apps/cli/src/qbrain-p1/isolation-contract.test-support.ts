// SPDX-License-Identifier: Apache-2.0
// SAME assertions for independent Mock and a later authorized Production factory.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { assertScenario, type HostProvider, type Reply, type Scenario } from "./host-contract";
import { CapturedBoundary, createFixture, inventory, type Access, type Fault } from "./isolation-fixture.test-support";

export interface IsolatedHostProvider extends HostProvider { unchangedAcknowledgment: boolean | undefined }
export type IsolationFactory = (script: Reply[], io: CapturedBoundary) => IsolatedHostProvider;
export type IsolationEvidence = { name:string; fault:Fault; root:string; before:ReturnType<typeof inventory>; after:ReturnType<typeof inventory>; accesses:Access[]; acknowledgment:boolean|undefined; observed:unknown; state:unknown; rejection?:string };
export async function assertIsolatedHost(factory:IsolationFactory, original:Scenario, parent:string, fault:Fault="none", capture:(e:IsolationEvidence)=>void=()=>{}) {
  const fixture=createFixture(parent,original.input);
  const scenario:Scenario={...original,input:fixture.input,replies:structuredClone(original.replies),expected:structuredClone(original.expected)};
  // Relocate the requirement-derived storage effect only; all original boundary assertions remain.
  if(scenario.expected[0]?.kind==="storage") scenario.expected[0]={kind:"storage",value:{home:fixture.input.home,root:fixture.input.root,port:fixture.input.port}};
  const before=inventory(fixture.run), io=new CapturedBoundary(fixture,fault);
  const provider=factory(scenario.replies,io); let observed:unknown;
  const evidence=():IsolationEvidence=>({name:scenario.name,fault,root:fixture.run,before,after:inventory(fixture.run),accesses:structuredClone(io.accesses),acknowledgment:provider.unchangedAcknowledgment,observed,state:provider.snapshot()});
  try {
    observed=await assertScenario(provider,scenario);
    const after=inventory(fixture.run);
    const external=(all:typeof before)=>all.filter(e=>e.path.startsWith("original-synthetic/") || e.path.startsWith("peer-synthetic/"));
    assert.deepStrictEqual(external(after),external(before),"external bytes/files must remain identical");
    // Whole inventory also rejects unlogged writes outside the two seeded external roots.
    const journalPath=join(fixture.input.root,"request.json");
    const journalRelative=relative(fixture.run,journalPath).split(sep).join("/");
    assert.deepStrictEqual(after.filter(e=>e.path!==journalRelative),before,"only the declared derivative journal may change");
    const identity=scenario.input.binding;
    const request={binding:identity,request:scenario.input.request};
    const result=scenario.expected.some(e=>e.kind==="audit") ? scenario.expected.find(e=>e.kind==="audit")!.value as {text:string} : undefined;
    const journal=result ? {...request,result:result.text} : request;
    assert.ok(after.some(e=>e.path===journalRelative),"required derivative storage write exists");
    assert.deepStrictEqual(JSON.parse(readFileSync(journalPath,"utf8")),journal,"actual storage payload retains captured identity and full text");
    const access=(kind:string,target:string,value:unknown):Access=>({kind,target,value,identity,namespace:identity.workspace});
    const expected:Access[]=[
      access("env","HOME",fixture.active), access("env","QB_STATE_ROOT",fixture.input.root),
      access("env","QB_HUB_DISCOVERY",join(fixture.active,"hub.json")),access("env","QB_DIRECT_CREDENTIAL",join(fixture.active,"credential.json")),
      access("root",fixture.active,null),access("root",fixture.input.root,null),
      access("hub",join(fixture.active,"hub.json"),{identity:"cline-qb",namespace:identity.workspace,endpoint:"synthetic://derivative"}),
      access("credential",join(fixture.active,"credential.json"),{identity:identity.workspace,provider:scenario.input.provider,token:"synthetic-only-derivative"}),
      access("storage",journalPath,request),
    ];
    if(result) expected.push(access("storage",journalPath,journal));
    assert.deepStrictEqual(io.accesses,expected,"exact ordered access effects, identities, roots and values");
    assert.equal(provider.unchangedAcknowledgment,true,"acknowledgment is necessary but never sufficient");
    capture(evidence());
  } catch(error) {
    const e=evidence(); e.rejection=error instanceof Error ? error.message : String(error); capture(e); throw error;
  }
}

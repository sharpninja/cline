// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { afterAll, describe, it } from "vitest";
import { completionEvidenceCases, completionAllocation, type CompletionCase } from "./__fixtures__/p1-completion-evidence-cases";
import { ScriptedCompletionPersistence, type PersistenceFault, type Observation } from "./__fixtures__/p1-completion-evidence-model";
import { assertCompletionEvidence, assertionPrefix } from "./__fixtures__/p1-completion-evidence-contract";

const evidence: unknown[] = [];
const pick = (name: string): CompletionCase => {
 const fixture = completionEvidenceCases.find(c => c.name === name);
 if (!fixture) throw new Error("Unknown fixture " + name);
 return fixture;
};
interface Control { name: string; scenario: string; fault: PersistenceFault }
const controls: Control[] = [];
const add = (scenario: string, fault: PersistenceFault, label?: string) =>
 controls.push({ name: label ?? scenario + "/" + fault.boundary + "/" + fault.field + "/" + String(fault.value), scenario, fault });
const regular = "CRLF: decision-replay";
const equal = "CRLF: equal-decision-distinct-events";
const attested = "CRLF: attested-none";
const terminal = "CRLF: terminal-rejection";
const receiptIdentity = ["workspacePath", "agentIdentity", "mcpSessionId", "requestId", "eventId", "order", "payloadHash"];
for (const boundary of ["submit", "read", "replay"] as const) {
 for (const field of receiptIdentity) {
  add(regular, {boundary,field,value:field === "order" ? 999 : "rebound"});
  add(regular, {boundary,field:"omit:" + field});
 }
 for (const value of [undefined,null,0,-1,"1",true,1.5,NaN,Infinity,-Infinity,{},[],99]) {
  add(regular,{boundary,field:"revision",value},"typed-revision/" + boundary + "/" + String(value) + "/" + typeof value);
 }
 for (const field of ["omitted-response","omit:revision","omit:code"]) add(regular,{boundary,field});
 for (const value of ["queued","rejected","persisted-optimistic",""]) add(regular,{boundary,field:"code",value});
}
// Capture order and full set comparisons, including equal conclusions attached
// to DISTINCT immutable events. Same-count duplicate loss is not a counter test.
for (const field of ["actions","decisions","dialogs"] as const) {
 for (const value of ["omit","duplicate","reorder","rebind","duplicate-loss"]) add(equal,{boundary:"projection",field,value});
}
for (const value of ["omit","duplicate","reorder","stale","corrupt","rebind"]) add(regular,{boundary:"projection",field:"events",value});
for (const field of ["workspacePath","agentIdentity","nativeSessionId","mcpSessionId","requestId"]) {
 add("CRLF: native-root-isolation",{boundary:"turn",field:"root:" + field,value:"different-root"});
}
for (const field of ["callback-before-request","missing-callback","omit:turn.ingress","omit:event.submit","omit:event.read","omit:turn.read","omit:decision.explicit"]) {
 add(regular,{boundary:"trace",field});
}
for (const field of ["ingress","retained","committed","retired","final-persisted","decision-attestations"]) add(regular,{boundary:"effect",field});
add(attested,{boundary:"trace",field:"omit:decision.explicit"},"no-decision requires explicit decision call");
add(attested,{boundary:"effect",field:"decision-attestations"},"no-decision attestation cannot be omitted");
add(terminal,{boundary:"effect",field:"rejected"},"terminal rejection remains visible even when journal empty");
add(terminal,{boundary:"effect",field:"invent-success"},"terminal rejection cannot manufacture success");
add("CRLF: canceled",{boundary:"turn",field:"extra-final"},"cancellation cannot invent final");
add(regular,{boundary:"effect",field:"invent-success"},"persisted final is not operator delivery");
add(regular,{boundary:"turn",field:"omit-ingress"});
add(regular,{boundary:"turn",field:"queryTitle:summary"},"summary title retained separately");
for (const variant of ["CRLF","CR","mixed","Markdown","Unicode","literal-escapes","decoded-dashes","JSON-escaped-decoded-dashes"]) {
 const scenario=variant + ": decision-replay";
 for (const target of ["queryText","response"]) {
  for (const mode of ["summary","truncate","newline"]) add(scenario,{boundary:"turn",field:target + ":" + mode});
 }
}
for (const target of ["queryText","response"]) {
 add("CRLF: decision-replay",{boundary:"turn",field:target + ":trim"});
 add("Unicode: decision-replay",{boundary:"turn",field:target + ":unicode"});
 add("literal-escapes: decision-replay",{boundary:"turn",field:target + ":literal"});
}

describe("P1 exact complete evidence prerequisite (test-only; production unbound)", () => {
 for (const fixture of completionEvidenceCases) {
  it("correct independent state/interactions: " + fixture.name, async () => {
   const actual = await assertCompletionEvidence(fixture,new ScriptedCompletionPersistence());
   evidence.push({name:fixture.name,input:fixture.input,observed:actual,passed:true,productionBound:false});
  });
 }
 for (const control of controls) {
  it("SAME assertions reject: " + control.name, async () => {
   let observed: Observation | undefined, failure: unknown;
   const fake = new ScriptedCompletionPersistence(control.fault);
   try {
    await assertCompletionEvidence(pick(control.scenario),{
     execute:async input => { observed=await fake.execute(input); return observed; },
    });
   } catch(error) { failure=error; }
   // An incidental TypeError/parse error/throw is NOT a passing negative control.
   assert.ok(failure instanceof assert.AssertionError,"Control did not reach intended assertion: " + control.name);
   assert.ok(failure.message.startsWith(assertionPrefix),"Wrong rejection boundary: " + control.name);
   evidence.push({control,assertion:failure.message.split("\n")[0],code:failure.code,observed,rejected:true});
  });
 }
});
afterAll(() => {
 console.log("K13_EXACT_COMPLETION_EVIDENCE " + JSON.stringify({
  scope:"independent mock prerequisite only",productionBound:false,correct:completionEvidenceCases.length,
  negativeControls:controls.length,originalUniqueVectors:501,originalPackageRegistrations:4788,
  importedRunnerRegistrations:0,allocation:completionAllocation,evidence,
 }));
});

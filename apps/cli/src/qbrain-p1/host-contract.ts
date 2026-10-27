// SPDX-License-Identifier: Apache-2.0
// Test-only host contract. No production entrypoint imports this module.
import assert from "node:assert/strict";

export type Binding = { workspace: string; nativeSession: string; agent: string; session: string; request: string; event: string; policy: string };
export type Input = { host: string; entry: string; binding: Binding; request: string; result: string; provider: string; model: string; proxy: string; home: string; root: string; upstream: string; port: number; remote: boolean; overrides: string[]; operation: "work" | "recover" | "delegate"; canary: string; secrets: string[] };
export type Reply = { boundary: string; value: unknown };
export type Effect = { kind: string; value: unknown };
export interface HostProvider { perform(input: Input): Promise<Effect[]>; snapshot(): {storage:[string,{home:string;port:number}][];persisted:[string,{binding:Binding;request:string;result?:string}][];providerCalls:unknown[];deliveries:{binding:Binding;text:string}[];open:[string,Binding][]}; }
export type Scenario = { name: string; ac: string[]; uc: string[]; input: Input; replies: Reply[]; expected: Effect[] };
export const effect = (kind: string, value: unknown): Effect => ({ kind, value });
export const reply = (boundary: string, value: unknown): Reply => ({ boundary, value });
export async function assertScenario(provider: HostProvider, scenario: Scenario): Promise<Effect[]> {
  // The sole assertion path for independent Mock and later Production adapters.
  const observed = await provider.perform(structuredClone(scenario.input));
  assert.deepStrictEqual(observed, scenario.expected, scenario.name);
  const state=provider.snapshot();
  assert.deepStrictEqual(state.providerCalls,scenario.expected.filter(e=>e.kind==="provider").map(e=>e.value),`${scenario.name}/provider-state`);
  if(scenario.expected.some(e=>e.kind==="success")){
    assert.deepStrictEqual(state.storage,[[scenario.input.root,{home:scenario.input.home,port:scenario.input.port}]],`${scenario.name}/storage-state`);
    assert.deepStrictEqual(state.persisted,[[scenario.input.binding.request,{binding:scenario.input.binding,request:requirementText(scenario.input,scenario.input.request),result:requirementText(scenario.input,scenario.input.result)}]],`${scenario.name}/audit-state`);
    assert.deepStrictEqual(state.deliveries,[{binding:scenario.input.binding,text:requirementText(scenario.input,scenario.input.result)}],`${scenario.name}/delivery-state`);
    assert.deepStrictEqual(state.open,[],`${scenario.name}/closed-state`);
  }else assert.deepStrictEqual(state.deliveries,[],`${scenario.name}/blocked-delivery-state`);
  return observed;
}

export const hosts = [
  ["cli", "one-shot"], ["cli", "interactive"], ["cli", "resume"], ["cli", "rebuild"], ["cli", "recovery"], ["cli", "acp"], ["cli", "zen"], ["cli", "daemon"], ["cli", "connector"],
  ["hub", "start"], ["hub", "fork"], ["hub", "restore"], ["hub", "message"], ["hub", "schedule"], ["hub", "connector"], ["hub", "dashboard"], ["hub", "self-invocation"],
  ["vscode", "activate"], ["vscode", "start"], ["vscode", "resume"], ["vscode", "rebuild"],
  ["quickstart", "start"], ["cli-agent", "start"], ["multi-agent", "start"], ["multi-agent", "synthesize"], ["code-review-bot", "start"], ["cline-core-cli-agent", "start"], ["example-vscode", "activate"], ["example-vscode", "resume"],
] as const;
export const bypasses = ["configExtensions", "toolPolicies", "enableTools", "enableSpawnAgent", "enableAgentTeams", "disableMcpSettingsTools", "cron.tools", "cron.extensions", "settings.toggle", "disabledTools", "disabledPlugins", "disabledAgentPlugins", "CLINE_QB_path_override", "CLINE_path_override", "CLINE_PLUGIN_IMPORT_TIMEOUT_MS", "hooksEnabled", "yolo", "system", "compaction.system_prompt", "reserved-contribution", "rewritten-input", "providerExecuted"];

export function baseInput(host: string, entry: string): Input {
  return { host, entry, binding: {workspace:"fixture-workspace", nativeSession:"fixture-native", agent:"ClineQb", session:"fixture-mcp", request:"fixture-request", event:"fixture-ingress", policy:"fixture-policy"}, request:"## Request\r\n\tExact text: 雪\n\n", result:"## Result\r\n  exact **Markdown** 雪\n\n", provider:"direct-fixture", model:"explicit-model", proxy:"http://fixture-proxy.invalid", home:"synthetic-home", root:"synthetic-home/.cline-qb/data", upstream:"synthetic-home/.cline", port:39117, remote:true, overrides:[], operation:"work", canary:"external-canary-unchanged",secrets:[] };
}
export function requirementText(input:Input,text:string):string {
  let value=text.replaceAll("\u2013","-").replaceAll("\u2014","-");
  for(const secret of input.secrets.filter(Boolean))value=value.split(secret).join("[REDACTED]");
  return value;
}
export function validReplies(input: Input): Reply[] {
  return [reply("assets", {pin:true,runtime:true,modules:true}), reply("trust", {verified:true,policy:input.binding.policy}), reply("hub", {identity:"cline-qb",policy:input.binding.policy}), reply("guidance", {skills:["pinned-inventory"],memory:"REQUIRED MEMORIES - None.",requirements:["effective-fixture"]}), reply("ingress", {binding:input.binding,code:"persisted",revision:1}), reply("authorize", {allow:true,policy:input.binding.policy}), reply("provider", {provider:input.provider,model:input.model,text:input.result}), reply("audit", {binding:input.binding,text:requirementText(input,input.result),code:"persisted",revision:2,decision:true,verification:true,title:"Fixture work result"}), reply("completion", {allow:true,policy:input.binding.policy}), reply("delivery", {delivered:true})];
}
export function expectedSuccess(input: Input): Effect[] {
  input={...input,request:requirementText(input,input.request),result:requirementText(input,input.result)};
  // Requirement-derived expected interactions, independent of the model implementation.
  return [effect("storage",{home:input.home,root:input.root,port:input.port}),effect("assets",null),effect("trust",{workspace:input.binding.workspace}),effect("hub",{port:input.port}),effect("guidance",null),effect("ingress",{binding:input.binding,text:requirementText(input,input.request)}),effect("authorize",{binding:input.binding,operation:input.operation,overrides:input.overrides}),effect("provider",{binding:input.binding,provider:input.provider,model:input.model,proxy:input.proxy,guidance:{skills:["pinned-inventory"],memory:"REQUIRED MEMORIES - None.",requirements:["effective-fixture"]},request:requirementText(input,input.request)}),effect("audit",{binding:input.binding,text:input.result}),effect("completion",{binding:input.binding}),effect("delivery",{binding:input.binding,text:input.result}),effect("success",{request:input.binding.request}),effect("canary",input.canary)];
}
export function successScenario(host: string, entry: string, overrides: string[] = [], operation: Input["operation"] = "work"): Scenario {
  const input=baseInput(host,entry); input.overrides=overrides;input.operation=operation;
  return {name:`${host}/${entry}/${operation}/${overrides.join(",")}`,ac:["001","002","003","004","005","006","007","008","009","010","011","012","013","014","015","016","017","018","029","053","069","070","071","072"].map(x=>`AC-QB-${x}`),uc:["UC-QB-001","UC-QB-002","UC-QB-003","UC-QB-004","UC-QB-005"],input,replies:validReplies(input),expected:expectedSuccess(input)};
}

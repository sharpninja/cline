// SPDX-License-Identifier: Apache-2.0
import { deepStrictEqual, equal } from "node:assert/strict";
import type { Dependencies, DesktopSubject, Effect, Input, Reply } from "./p1-desktop-model.fixture";
export type Script = { name: string; reply: Reply; throws?: string }[];
export type Scenario = { name: string; ac: number[]; uc: number[]; flow: "basic" | "alternative"; input: Input; script: Script; effects: Effect[]; badScript?: Script };
export type Observation = { replies: { name: string; reply: Reply }[]; calls: { name: string; data: unknown }[]; effects: Effect[]; remainingResponses: number };
export type Fault = "none" | "omit-response" | "reorder-response" | "wrong-response" | "drop-effect" | "reorder-effect" | "extra-delivery" | "misroute-call";
export const input = (operation: Input["operation"], extra: Partial<Input> = {}): Input => ({ operation, context: "workspace-a/session-a", generation: 1, home: "T:/synthetic/run/home", stateRoot: "T:/synthetic/run/home/.cline-qb", upstreamRoot: "T:/synthetic/run/home/.cline", port: 0, auditEvent: operation === "work" ? { workspaceId: "workspace-a", agentIdentity: "ClineQb", mcpSessionId: "session-a", requestId: "request-a", eventId: "event-a", order: 1, method: "complete", payloadHash: "synthetic-event-hash-a" } : undefined, ...extra });
const binding = { context: "workspace-a/session-a", generation: 1 };
const owner = { ...binding, requestId: "request-a" };
const effect = (kind: string, data: unknown): Effect => ({ kind, data });
const blocked = (reason: string) => effect("blocked", { context: binding.context, reason, recovery: "Settings or supported diagnostics" });
export const startupScript: Script = [
  { name: "assets", reply: { complete: true, compatible: true, signed: true } },
  { name: "trust", reply: { signature: true, nonce: true, health: true, auth: true } },
  { name: "guidance", reply: { available: true, skills: "pinned", requirements: "effective", memories: "None" } },
  { name: "hub", reply: { identity: "cline-qb", policy: "policy-1" } },
];
const startupEffects = (extra: Partial<Input> = {}): Effect[] => [
  effect("environment", { home: input("startup").home, root: input("startup").stateRoot, port: 0, proxy: extra.proxy ?? null }),
  effect("capabilities", ["tools", "skills", "audit", "completion"]),
  effect("guidance", { memories: "None", skills: "pinned", requirements: "effective", markerPrompt: false }),
  effect("ready", { ...binding, native: extra.native === true, lifecycle: extra.lifecycle ?? "launch" }),
];
const provider = { id: "direct", enabled: true, auth: "key", endpointRequired: false, models: ["model-a", "model-b"] };
const selection = { provider: "direct", model: "model-b" };
const catalogReply = { ...binding, status: "ok", providers: [provider] };
const catalogEffect = effect("catalog", [{ id: "direct", models: ["model-a", "model-b"] }]);
const catalogScript = (reply: Reply = catalogReply): Script => [{ name: "catalog", reply }];
const cloneScript = (script: Script) => script.map(step => ({ ...step, reply: structuredClone(step.reply) }));
const replaceReply = (script: Script, index: number, patch: Reply): Script => script.map((step, i) => i === index ? { ...step, reply: { ...step.reply, ...patch } } : structuredClone(step));
export const scenarios: Scenario[] = [];
const add = (name: string, ac: number[], operation: Input["operation"], extra: Partial<Input>, script: Script, effects: Effect[], uc: number[] = [5], flow: Scenario["flow"] = "basic", badScript?: Script) => scenarios.push({ name, ac, uc, flow, input: input(operation, extra), script: cloneScript(script), effects, badScript });

for (const lifecycle of ["launch", "resume", "rebuild", "schedule", "connector", "delegate", "team", "compaction", "reconnect", "remote"]) {
  add("trusted " + lifecycle, [1, 3, 4, 6, 13, 14, 15, 70, 72], "startup", { lifecycle }, startupScript, startupEffects({ lifecycle }), [1, 4]);
}
for (const bypass of ["configExtensions", "toolPolicies", "enableTools", "enableSpawnAgent", "enableAgentTeams", "disableMcpSettingsTools", "cron.tools", "cron.extensions", "settings.toggle", "disabledTools", "disabledPlugins", "disabledAgentPlugins", "CLINE_QB_OVERRIDE", "CLINE_PLUGIN_IMPORT_TIMEOUT_MS", "hooksEnabled", "yolo", "system", "compaction.system_prompt", "same-name contribution"]) {
  add("protected capability: " + bypass, [2, 6, 13], "startup", { bypass }, startupScript, startupEffects(), [1, 4]);
}
for (const failure of ["missing runtime", "module absent", "wrong architecture", "incompatible module", "missing REPL", "digest mismatch", "unsigned contract", "shadowed module"]) {
  const script = replaceReply(startupScript, 0, failure === "shadowed module" ? { shadowed: true } : failure === "unsigned contract" ? { signed: false } : { complete: false, diagnostic: failure });
  add(failure, [3, 70], "startup", {}, script.slice(0, 1), [startupEffects()[0], blocked("assets")], [1], "alternative", startupScript);
}
for (const field of ["signature", "nonce", "health", "auth"]) {
  add("trust " + field + " fails without further probing", [4], "startup", {}, replaceReply(startupScript, 1, { [field]: false }).slice(0, 2), [...startupEffects().slice(0, 2), blocked("trust")], [1, 2], "alternative", startupScript);
}
for (const patch of [{ available: false }, { skills: "missing" }, { requirements: "unavailable" }]) {
  add("guidance unavailable " + JSON.stringify(patch), [6], "startup", {}, replaceReply(startupScript, 2, patch).slice(0, 3), [...startupEffects().slice(0, 2), blocked("guidance")], [1], "alternative", startupScript);
}
for (const patch of [{ identity: "cline" }, { policy: "other" }, { occupied: true }]) {
  add("hub refusal " + JSON.stringify(patch), [15, 53], "startup", {}, replaceReply(startupScript, 3, patch), [...startupEffects().slice(0, 3), blocked("hub_identity")], [1, 4], "alternative", startupScript);
}
for (const proxy of [undefined, "http://synthetic-proxy:39001"]) {
  add("compiled isolated " + (proxy ? "proxy" : "normal"), [53, 68, 71], "startup", { native: true, proxy }, startupScript, startupEffects({ native: true, proxy }), [1]);
}
for (const patch of [{ home: "" }, { stateRoot: "T:/synthetic/run/home/.cline/data" }, { stateRoot: "T:/operator/data" }, { port: 25473 }]) {
  add("unsafe fixture " + JSON.stringify(patch), [53, 68, 71], "startup", patch, [], [blocked("fixture_isolation")], [1, 3], "alternative");
}
const onboardingPrefix = [effect("onboarding", { account: false, githubActivation: false, upsell: false })];
for (const legacy of [undefined, { provider: "cline", model: "hosted" }]) {
  add("direct onboarding with legacy " + !!legacy, [16, 17, 18, 61, 62], "onboarding", { selection, legacy, keyOnly: true }, [...catalogScript(), { name: "saveProvider", reply: { saved: true } }], [...onboardingPrefix, effect("storage", { ...binding, selection }), effect("advance", binding)]);
}
add("skip restored GitHub step", [16, 17, 61], "onboarding", { cancel: true, legacy: { provider: "cline", model: "hosted" } }, [], [...onboardingPrefix, effect("skipped", binding)], [5], "alternative");
for (const id of ["cline", "cline-pass", "cline-cloud", " CLINE-PASS "]) {
  add("excluded onboarding " + id, [16, 17, 61, 62], "onboarding", { selection: { provider: id, model: "hosted" }, keyOnly: true }, catalogScript({ ...catalogReply, providers: [{ ...provider, id }] }), [...onboardingPrefix, blocked("configure_direct_provider")], [5], "alternative");
}
for (const patch of [{ auth: "oauth" }, { endpointRequired: true }, { enabled: false }]) {
  add("key-only incompatibility " + JSON.stringify(patch), [62], "onboarding", { selection, keyOnly: true }, catalogScript({ ...catalogReply, providers: [{ ...provider, ...patch }] }), [...onboardingPrefix, blocked("configure_direct_provider")], [5], "alternative");
}
add("onboarding save failure", [62], "onboarding", { selection, keyOnly: true }, [...catalogScript(), { name: "saveProvider", reply: { saved: false } }], [...onboardingPrefix, blocked("save_failed")], [5], "alternative");
for (const status of ["failed", "delayed", "disabled"]) {
  add("schedule catalog " + status, [63], "catalog", {}, catalogScript({ ...catalogReply, status }), [blocked("catalog_" + status)], [5], "alternative");
}
add("empty catalog has no fallback", [63, 64], "schedule", {}, catalogScript({ ...catalogReply, providers: [] }), [effect("catalog", []), blocked("explicit_provider_model_required")], [5], "alternative");
add("stale hosted catalog is excluded", [16, 17, 63], "catalog", {}, catalogScript({ ...catalogReply, providers: [provider, { ...provider, id: "cline" }, { ...provider, id: "cline-pass" }] }), [catalogEffect]);
for (const generation of [0, 2]) add("discard delayed catalog generation " + generation, [5, 63, 72], "catalog", {}, catalogScript({ ...catalogReply, generation }), [effect("discard", { reason: "old_context" })], [2, 5], "alternative");
for (const mode of ["explicit", "remembered", "legacy", "structured"]) {
  const extra: Partial<Input> = mode === "explicit" ? { selection } : mode === "remembered" ? { remembered: selection } : mode === "legacy" ? { legacy: selection } : { hasStructured: true, structured: selection, legacy: { provider: "cline", model: "wrong" } };
  add("schedule preserves " + mode + " pair", [64, 65, 66], "schedule", extra, [...catalogScript(), { name: "saveSchedule", reply: { saved: true } }], [catalogEffect, effect("storage", { ...binding, selection })]);
}
for (const selected of [undefined, { provider: "direct" }, { model: "model-b" }, { provider: "direct", model: "other-provider-model" }, { provider: "cline", model: "hosted" }]) {
  add("incomplete schedule " + JSON.stringify(selected), [64, 65], "schedule", { selection: selected }, catalogScript(), [catalogEffect, blocked("explicit_provider_model_required")], [5], "alternative");
}
for (const structured of [undefined, null, {}, { provider: "direct" }, { model: "model-b" }, { provider: "cline", model: "hosted" }]) {
  add("authoritative malformed structured pair " + JSON.stringify(structured), [66], "schedule", { hasStructured: true, structured, legacy: selection }, catalogScript(), [catalogEffect, blocked("explicit_provider_model_required")], [5], "alternative");
}
add("cancel legacy hosted edit without rewrite", [65], "schedule", { legacy: { provider: "cline", model: "hosted" }, cancel: true }, catalogScript(), [catalogEffect], [5], "alternative");
add("schedule failed save retains selection", [64, 65], "schedule", { selection }, [...catalogScript(), { name: "saveSchedule", reply: { saved: false } }], [catalogEffect, blocked("save_failed")], [5], "alternative");
for (const target of ["local", "ssh-owned"]) {
  add("explicit recovery " + target, [14, 15, 18, 67, 72], "recovery", { target, explicit: true, selection }, [{ name: "recover", reply: { ...binding, trusted: true, policy: "policy-1" } }], [effect("newSession", { ...binding, selection, target })], [2, 4, 5]);
}
add("hosted recovery rejected without account link", [16, 17, 67], "recovery", { target: "cloud", selection }, [], [blocked("cloud_excluded")], [2, 5], "alternative");
add("hosted history requires new session", [67], "recovery", { target: "local", selection }, [], [blocked("explicit_new_session_required")], [2, 5], "alternative");
add("recovery missing selection stays incomplete", [67], "recovery", { explicit: true }, [], [blocked("configure_direct_provider")], [2, 5], "alternative");
for (const patch of [{ trusted: false }, { policy: "changed" }, { generation: 0 }]) {
  add("recovery callback " + JSON.stringify(patch), [5, 67, 72], "recovery", { explicit: true, selection }, [{ name: "recover", reply: { ...binding, trusted: true, policy: "policy-1", ...patch } }], ["generation" in patch ? effect("discard", { reason: "old_context" }) : blocked("revalidation")], [2, 4, 5], "alternative");
}
export const workScript: Script = [
  { name: "authorize", reply: { current: true, trusted: true } },
  { name: "beforeTool", reply: { authorized: true, observable: true } },
  { name: "provider", reply: { ...binding, authenticated: true, provider: "direct", model: "model-b" } },
  { name: "persist", reply: { context: binding.context, requestId: "request-a", code: "persisted", complete: true, revision: 1, workspaceId: "workspace-a", agentIdentity: "ClineQb", mcpSessionId: "session-a", eventId: "event-a", order: 1, method: "complete", payloadHash: "synthetic-event-hash-a", requestText: "request\r\nfull", finalText: "full\r\nresult" } },
  { name: "verify", reply: { passed: true, fingerprint: "fp-1", policy: "policy-1" } },
  { name: "complete", reply: { current: true, pending: 0, rejected: 0, lost: 0, quarantined: 0, decision: true, title: "summary", phaseAuthorized: true } },
];
const workEffects: Effect[] = [
  effect("audit", { ...owner, type: "request", text: "request\r\nfull" }),
  effect("execution", { ...owner, input: "echo synthetic" }),
  effect("provider", { ...owner, provider: "direct", model: "model-b" }),
  effect("audit", { ...owner, type: "tool_execution", input: "echo synthetic" }),
  effect("decision", { ...owner, conclusion: "Use explicit direct provider", representations: ["designDecisions", "dialog", "action"] }),
  effect("delivery", { ...owner, text: "full\r\nresult", path: "text" }),
];
for (const lifecycle of ["text", "tool", "delegate", "team", "resume", "steering"]) add("audited delivery " + lifecycle, [5, 7, 8, 9, 10, 11, 12, 14, 18, 69, 72], "work", { selection, lifecycle }, workScript, [...workEffects.slice(0, 5), effect("delivery", { ...owner, text: "full\r\nresult", path: lifecycle })], [2, 3, 4, 5]);
const failures: { index: number; patch: Reply; reason: string; prefix: number; ac: number[] }[] = [
  { index: 0, patch: { current: false }, reason: "revalidation", prefix: 0, ac: [72] },
  { index: 1, patch: { authorized: false }, reason: "tool_policy", prefix: 1, ac: [2] },
  { index: 1, patch: { observable: false }, reason: "tool_policy", prefix: 1, ac: [2] },
  { index: 2, patch: { authenticated: false }, reason: "provider_authentication", prefix: 2, ac: [18] },
  { index: 2, patch: { provider: "cline" }, reason: "provider_authentication", prefix: 2, ac: [16, 17] },
  ...["queued", "unchanged", "rejected", "lost"].map(code => ({ index: 3, patch: { code }, reason: "audit_incomplete", prefix: 5, ac: [9, 10] })),
  ...[{ complete: false }, { revision: 0 }, { context: "workspace-b/session-b" }, { requestId: "other" }, { finalText: "summary" }, { requestText: "request\nfull" }].map(patch => ({ index: 3, patch, reason: "audit_incomplete", prefix: 5, ac: [5, 9, 69] })),
  ...[{ passed: false }, { fingerprint: "stale" }, { policy: "other" }].map(patch => ({ index: 4, patch, reason: "verification", prefix: 5, ac: [11] })),
  ...[{ current: false }, { pending: 1 }, { rejected: 1 }, { lost: 1 }, { quarantined: 1 }, { decision: false }, { title: "User prompt" }, { phaseAuthorized: false }].map(patch => ({ index: 5, patch, reason: "completion_obligations", prefix: 5, ac: [10, 12, 72] })),
];
for (const failure of failures) add("work failure " + failure.index + " " + JSON.stringify(failure.patch), failure.ac, "work", { selection }, replaceReply(workScript, failure.index, failure.patch).slice(0, failure.index + 1), [...workEffects.slice(0, failure.prefix), blocked(failure.reason)], [2, 3], "alternative", workScript);
add("wrong-context provider callback cannot deliver", [5, 72], "work", { selection }, replaceReply(workScript, 2, { generation: 0 }).slice(0, 3), [...workEffects.slice(0, 2), effect("discard", { reason: "old_context" })], [2, 3, 4], "alternative", workScript);
add("implicit ambiguous turn", [5, 7], "work", { openRequests: ["request-a", "request-b"] }, [], [blocked("request_ambiguous")], [3], "alternative");
add("foreign turn", [5, 7], "work", { requestId: "foreign" }, [], [blocked("request_unknown")], [3], "alternative");
add("explicit targeting with two open turns", [5, 7], "work", { openRequests: ["request-a", "request-b"], requestId: "request-a", selection }, workScript, workEffects, [3]);
add("request and delivered output secret masking", [29, 69], "work", { selection, secrets: ["synthetic-marker-secret"], requestText: "synthetic-marker-secret", finalText: "synthetic-marker-secret" }, replaceReply(workScript, 3, { requestText: "[MASKED]", finalText: "[MASKED]" }), [effect("audit", { ...owner, type: "request", text: "[MASKED]" }), ...workEffects.slice(1, 5), effect("delivery", { ...owner, text: "[MASKED]", path: "text" })], [3]);
add("native updater inert with legacy source", [16, 17, 56], "updater", { target: "https://updates.cline.bot" }, [], [effect("updatePolicy", { automatic: false, endpoints: [], replacement: false })], [5], "alternative");

// O-D-REVISION-001: revision is the desktop logical adapter projection of a
// positive COMMITTED serverRevision. This is not a raw SubmitAsync response:
// a turn outcome or synthetic acknowledgment cannot populate this projection.
for (const revision of [2, 42, Number.MAX_SAFE_INTEGER]) {
  add("committed desktop revision " + revision, [9, 10, 69], "work", { selection }, replaceReply(workScript, 3, { revision }), workEffects, [2, 3], "basic", replaceReply(workScript, 3, { revision: 0 }).slice(0, 4));
}
for (const revision of [undefined, null, 0, -1, 1.5, "2", "", false, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
  add("reject malformed desktop revision " + String(revision), [9, 10], "work", { selection }, replaceReply(workScript, 3, { revision }).slice(0, 4), [...workEffects.slice(0, 5), blocked("audit_incomplete")], [2, 3], "alternative", workScript);
}
for (const field of ["workspaceId", "agentIdentity", "mcpSessionId", "eventId", "order", "method", "payloadHash"]) {
  for (const value of [undefined, field === "order" ? 2 : "foreign-" + field]) {
    add("reject receipt identity " + field + " " + String(value), [5, 9, 10], "work", { selection }, replaceReply(workScript, 3, { [field]: value }).slice(0, 4), [...workEffects.slice(0, 5), blocked("audit_incomplete")], [2, 3], "alternative", workScript);
  }
}

// The dependency fake receives inputs and scripts, never Scenario.effects or .name.
export async function observe(subject: DesktopSubject, operation: Input, replies: Script, fault: Fault = "none"): Promise<Observation> {
  const queue = cloneScript(replies);
  if (fault === "omit-response") queue.shift();
  if (fault === "reorder-response" && queue.length > 1) [queue[0], queue[1]] = [queue[1], queue[0]];
  if (fault === "wrong-response" && queue.length) queue[0].reply = { malformed: true };
  const result: Observation = { replies: [], calls: [], effects: [], remainingResponses: 0 };
  const dependencies: Dependencies = {
    async call(name, data) {
      const delivered = structuredClone(data) as Record<string, unknown>;
      if (fault === "misroute-call") delivered.context = "foreign-workspace";
      result.calls.push({ name, data: delivered });
      const step = queue.shift();
      if (!step) throw new Error("missing_response");
      if (step.name !== name) throw new Error("response_order");
      result.replies.push({ name: step.name, reply: structuredClone(step.reply) });
      if (step.throws) throw new Error(step.throws);
      // Async callback boundary, allowing stale context responses to be exercised.
      await Promise.resolve();
      return structuredClone(step.reply);
    },
    effect(kind, data) {
      if (fault === "drop-effect" && result.effects.length === 0) { result.effects.push({ kind: "missing_effect", data: null }); return; }
      result.effects.push({ kind, data: structuredClone(data) });
    },
  };
  await subject.execute(structuredClone(operation), dependencies);
  if (fault === "extra-delivery") dependencies.effect("delivery", { context: "foreign", text: "unauthorized" });
  if (fault === "reorder-effect" && result.effects.length > 1) [result.effects[0], result.effects[1]] = [result.effects[1], result.effects[0]];
  result.remainingResponses = queue.length;
  return result;
}
// ONE assertion path for Mock and the later constructor-injected Production adapter.
export function assertScenario(scenario: Scenario, observed: Observation): void {
  equal(observed.remainingResponses, 0, "all scripted dependencies must be consumed");
  deepStrictEqual(observed.replies, scenario.script.map(step => ({ name: step.name, reply: step.reply })), "actual dependency responses including failure diagnostics");
  deepStrictEqual(observed.calls.map(call => call.name), scenario.script.map(step => step.name), "dependency interaction order");
  for (const call of observed.calls) {
    const data = call.data as Record<string, unknown>;
    equal(data.context, scenario.input.context, "context ownership of every dependency call");
    equal(data.generation, scenario.input.generation, "generation ownership of every dependency call");
    const selected = scenario.input.hasStructured ? scenario.input.structured : scenario.input.selection ?? scenario.input.legacy ?? scenario.input.remembered;
    if (call.name === "saveProvider" || call.name === "saveSchedule" || call.name === "recover") deepStrictEqual(data.selection, call.name === "saveSchedule" ? selected : scenario.input.selection ?? scenario.input.remembered, "exact explicit provider/model pair at dependency boundary");
    if (call.name === "provider") {
      deepStrictEqual(data.selection, scenario.input.selection, "provider receives exact selected pair");
      equal(data.proxy, scenario.input.proxy ?? null, "configured proxy retained");
    }
    if (call.name === "beforeTool") equal(data.input, scenario.input.toolInput ?? "echo synthetic", "unchanged final execution arguments");
    if (call.name === "verify") equal(data.fingerprint, scenario.input.currentFingerprint ?? "fp-1", "current changed-state fingerprint");
    if (call.name === "persist") deepStrictEqual(data.event, scenario.input.auditEvent, "captured canonical event identity and payload hash sent unchanged");
    if (call.name === "persist" || call.name === "complete") {
      const expectedText = (scenario.input.finalText ?? "full\r\nresult").replace(/[\u2013\u2014]/g, "-");
      const redacted = (scenario.input.secrets ?? []).filter(Boolean).reduce((value, secret) => value.split(secret).join("[MASKED]"), expectedText);
      equal(data.finalText, redacted, "exact final delivery text before persistence/completion");
    }
    if (scenario.input.operation === "work") equal(data.requestId, scenario.input.requestId ?? "request-a", "request ownership");
  }
  deepStrictEqual(observed.effects, scenario.effects, "requirement-derived state/effects/delivery");
}
export async function runScenario(scenario: Scenario, createSubject: () => DesktopSubject, fault: Fault = "none", script = scenario.script): Promise<Observation> {
  const observed = await observe(createSubject(), scenario.input, script, fault);
  assertScenario(scenario, observed);
  return observed;
}



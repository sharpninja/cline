// SPDX-License-Identifier: Apache-2.0
// Test-only executable specification. It imports no product or governance code.
// Logical desktop adapter inputs, not a raw server receipt or new wire API.
// These fields are from the canonical AuditReceipt identity/payload contract.
export type AuditEvent = { workspaceId: string; agentIdentity: string; mcpSessionId: string; requestId: string; eventId: string; order: number; method: string; payloadHash: string };
export type Pair = { provider: string; model: string };
export type Effect = { kind: string; data: unknown };
export type Input = {
  operation: "startup" | "onboarding" | "catalog" | "schedule" | "recovery" | "work" | "updater";
  context: string;
  generation: number;
  home: string;
  stateRoot: string;
  upstreamRoot: string;
  port: number;
  proxy?: string;
  native?: boolean;
  lifecycle?: string;
  selection?: Partial<Pair>;
  legacy?: Pair;
  structured?: Partial<Pair> | null;
  hasStructured?: boolean;
  remembered?: Pair;
  target?: string;
  explicit?: boolean;
  cancel?: boolean;
  keyOnly?: boolean;
  bypass?: string;
  changed?: boolean;
  finalText?: string;
  requestText?: string;
  openRequests?: string[];
  requestId?: string;
  toolInput?: string;
  secrets?: string[];
  currentFingerprint?: string;
  auditEvent?: AuditEvent;
};
export type Reply = Record<string, unknown>;
export interface Dependencies {
  call(name: string, data: unknown): Promise<Reply>;
  effect(kind: string, data: unknown): void;
}
export interface DesktopSubject { execute(input: Input, dependencies: Dependencies): Promise<void> }
const excluded = (id: unknown) => typeof id === "string" && ["cline", "cline-pass", "cline-cloud"].includes(id.trim().toLowerCase());
const pair = (value: Partial<Pair> | null | undefined): value is Pair => !!value && typeof value.provider === "string" && !!value.provider.trim() && typeof value.model === "string" && !!value.model.trim() && !excluded(value.provider);
const mask = (value: string, secrets: string[] = []) => secrets.filter(Boolean).reduce((text, secret) => text.split(secret).join("[MASKED]"), value).replace(/[\u2013\u2014]/g, "-");

export class DesktopModel implements DesktopSubject {
  // Owns state per instance; no shared active context, expected results or case names.
  private saved = new Map<string, Pair>();
  async execute(input: Input, deps: Dependencies): Promise<void> {
    const emit = (kind: string, data: unknown) => deps.effect(kind, data);
    const blocked = (reason: string) => emit("blocked", { context: input.context, reason, recovery: "Settings or supported diagnostics" });
    const bind = { context: input.context, generation: input.generation };
    try {
      if (input.operation === "startup") {
        if (!input.home || !input.stateRoot.startsWith(input.home + "/") || (input.stateRoot === input.upstreamRoot || input.stateRoot.startsWith(input.upstreamRoot + "/")) || input.port !== 0) { blocked("fixture_isolation"); return; }
        emit("environment", { home: input.home, root: input.stateRoot, port: 0, proxy: input.proxy ?? null });
        const assets = await deps.call("assets", bind);
        if (assets.complete !== true || assets.compatible !== true || assets.signed !== true || assets.shadowed === true) { blocked("assets"); return; }
        emit("capabilities", ["tools", "skills", "audit", "completion"]);
        const trust = await deps.call("trust", bind);
        if (trust.signature !== true || trust.nonce !== true || trust.health !== true || trust.auth !== true) { blocked("trust"); return; }
        const guidance = await deps.call("guidance", bind);
        if (guidance.available !== true || guidance.skills !== "pinned" || guidance.requirements !== "effective") { blocked("guidance"); return; }
        emit("guidance", { memories: guidance.memories, skills: "pinned", requirements: "effective", markerPrompt: false });
        const hub = await deps.call("hub", bind);
        if (hub.identity !== "cline-qb" || hub.policy !== "policy-1" || hub.occupied === true) { blocked("hub_identity"); return; }
        emit("ready", { ...bind, native: input.native === true, lifecycle: input.lifecycle ?? "launch" });
      } else if (input.operation === "onboarding") {
        emit("onboarding", { account: false, githubActivation: false, upsell: false });
        if (input.cancel || !input.selection?.provider) { emit("skipped", bind); return; }
        const catalog = await deps.call("catalog", bind);
        const providers = Array.isArray(catalog.providers) ? catalog.providers as Reply[] : [];
        const selected = providers.find(provider => provider.id === input.selection?.provider && provider.enabled === true && !excluded(provider.id) && (!input.keyOnly || (provider.auth === "key" && provider.endpointRequired !== true)));
        if (!selected || !pair(input.selection)) { blocked("configure_direct_provider"); return; }
        const result = await deps.call("saveProvider", { ...bind, selection: input.selection });
        if (result.saved !== true) { blocked("save_failed"); return; }
        this.saved.set(input.context, { ...input.selection });
        emit("storage", { ...bind, selection: input.selection });
        emit("advance", bind);
      } else if (input.operation === "catalog" || input.operation === "schedule") {
        const catalog = await deps.call("catalog", bind);
        if (catalog.context !== input.context || catalog.generation !== input.generation) { emit("discard", { reason: "old_context" }); return; }
        if (catalog.status !== "ok") { blocked("catalog_" + String(catalog.status)); return; }
        const providers = (Array.isArray(catalog.providers) ? catalog.providers as Reply[] : []).filter(provider => provider.enabled === true && !excluded(provider.id));
        emit("catalog", providers.map(provider => ({ id: provider.id, models: provider.models })));
        if (input.operation === "catalog" || input.cancel) return;
        // Presence of the structured field is authoritative, including null/malformed.
        const selected = input.hasStructured ? input.structured : input.selection ?? input.legacy ?? input.remembered;
        const provider = providers.find(provider => provider.id === selected?.provider);
        if (!pair(selected) || !provider || !Array.isArray(provider.models) || !provider.models.includes(selected.model)) { blocked("explicit_provider_model_required"); return; }
        const save = await deps.call("saveSchedule", { ...bind, selection: selected });
        if (save.saved !== true) { blocked("save_failed"); return; }
        emit("storage", { ...bind, selection: selected });
      } else if (input.operation === "recovery") {
        if (input.target === "cloud") { blocked("cloud_excluded"); return; }
        if (!input.explicit) { blocked("explicit_new_session_required"); return; }
        const selected = input.selection ?? input.remembered;
        if (!pair(selected)) { blocked("configure_direct_provider"); return; }
        const runtime = await deps.call("recover", { ...bind, selection: selected });
        if (runtime.context !== input.context || runtime.generation !== input.generation) { emit("discard", { reason: "old_context" }); return; }
        if (runtime.trusted !== true || runtime.policy !== "policy-1") { blocked("revalidation"); return; }
        emit("newSession", { ...bind, selection: selected, target: input.target ?? "local" });
      } else if (input.operation === "updater") {
        emit("updatePolicy", { automatic: false, endpoints: [], replacement: false });
      } else {
        const open = input.openRequests ?? ["request-a"];
        const requestId = input.requestId ?? (open.length === 1 ? open[0] : undefined);
        if (!requestId) { blocked("request_ambiguous"); return; }
        if (!open.includes(requestId)) { blocked("request_unknown"); return; }
        const owner = { ...bind, requestId };
        const authorization = await deps.call("authorize", owner);
        if (authorization.current !== true || authorization.trusted !== true) { blocked("revalidation"); return; }
        const ingress = mask(input.requestText ?? "request\r\nfull", input.secrets);
        emit("audit", { ...owner, type: "request", text: ingress });
        const gate = await deps.call("beforeTool", { ...owner, input: input.toolInput ?? "echo synthetic" });
        if (gate.authorized !== true || gate.observable !== true) { blocked("tool_policy"); return; }
        emit("execution", { ...owner, input: input.toolInput ?? "echo synthetic" });
        const response = await deps.call("provider", { ...owner, selection: input.selection, proxy: input.proxy ?? null });
        if (response.context !== input.context || response.generation !== input.generation) { emit("discard", { reason: "old_context" }); return; }
        if (response.authenticated !== true || excluded(response.provider)) { blocked("provider_authentication"); return; }
        emit("provider", { ...owner, provider: response.provider, model: response.model });
        const finalText = mask(input.finalText ?? "full\r\nresult", input.secrets);
        emit("audit", { ...owner, type: "tool_execution", input: input.toolInput ?? "echo synthetic" });
        emit("decision", { ...owner, conclusion: "Use explicit direct provider", representations: ["designDecisions", "dialog", "action"] });
        const receipt = await deps.call("persist", { ...owner, event: input.auditEvent, requestText: ingress, finalText });
        if (receipt.context !== input.context || receipt.requestId !== requestId || receipt.code !== "persisted" || receipt.complete !== true || !Number.isSafeInteger(receipt.revision) || (receipt.revision as number) <= 0 || !input.auditEvent || input.auditEvent.requestId !== requestId || Object.entries(input.auditEvent).some(([field, value]) => receipt[field] !== value) || receipt.requestText !== ingress || receipt.finalText !== finalText) { blocked("audit_incomplete"); return; }
        const verification = await deps.call("verify", { ...owner, fingerprint: input.currentFingerprint ?? "fp-1" });
        if (verification.passed !== true || verification.fingerprint !== (input.currentFingerprint ?? "fp-1") || verification.policy !== "policy-1") { blocked("verification"); return; }
        const complete = await deps.call("complete", { ...owner, finalText });
        if (complete.current !== true || complete.pending !== 0 || complete.rejected !== 0 || complete.lost !== 0 || complete.quarantined !== 0 || complete.decision !== true || complete.title !== "summary" || complete.phaseAuthorized !== true) { blocked("completion_obligations"); return; }
        emit("delivery", { ...owner, text: finalText, path: input.lifecycle ?? "text" });
      }
    } catch (error) { blocked("dependency:" + (error instanceof Error ? error.message : String(error))); }
  }
}

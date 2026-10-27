// SPDX-License-Identifier: Apache-2.0
/** Test-only input-driven model of the existing required-model-context seam.
 * No case oracle, expected observation, production implementation or candidate artifact imports.
 */
export type Root = { workspacePath: string; agentIdentity: string; nativeSessionId: string; mcpSessionId: string; requestId: string };
export type Tool = { name: string; description: string; inputSchema: Record<string, unknown> };
export type Request = { systemPrompt: string; tools: Tool[]; messages: unknown[]; options: Record<string, unknown>; toolExecutionPolicy?: "host-only" };
export type Context = { guidance: string; tools: Tool[] };
export type Invocation = { root: Root; transition: "request" | "prompt-replacement" | "compaction" | "rebuild" | "resume"; request: Request };
export type Reply = { context?: unknown; error?: string };
export type Interaction = { method: string; root: Root; data?: unknown };
export type Observation = {
  providerRequests: { root: Root; request: Request }[];
  decisions: { root: Root; outcome: string; diagnostic?: string }[];
  interactions: Interaction[];
  unrelatedSkillExecutions: string[];
  providerToolExecutions: string[];
};
export interface ContextAdapter {
  execute(invocations: Invocation[], replies: Reply[], fault?: Fault): Promise<Observation>;
}
export const faults = [
  "omit-context-read", "duplicate-context-read", "stale-context-reply", "missing-guidance-line",
  "normalise-line-endings", "unicode-corruption", "missing-required-tool", "wrong-tool-schema",
  "wrong-required-description", "replace-source-callback", "dispatch-before-context",
  "omit-dispatch", "duplicate-dispatch", "wrong-root", "provider-tool-execution",
  "unrelated-skill-execution", "finish-before-dispatch", "shared-context-mutation",
] as const;
export type Fault = typeof faults[number];
const copy = <T>(value: T): T => structuredClone(value);
const diagnostic = "Required governed model context is unavailable or invalid.";
function valid(raw: unknown): raw is Context {
  if (!raw || typeof raw !== "object") return false;
  const value = raw as Context;
  if (typeof value.guidance !== "string" || !value.guidance.trim() || !Array.isArray(value.tools) || !value.tools.length) return false;
  const names = new Set<string>();
  for (const tool of value.tools) {
    if (!tool || typeof tool.name !== "string" || !tool.name.trim() || tool.name !== tool.name.trim() ||
      names.has(tool.name) || typeof tool.description !== "string" || !tool.description.trim() ||
      !tool.inputSchema || typeof tool.inputSchema !== "object" || Array.isArray(tool.inputSchema)) return false;
    names.add(tool.name);
  }
  return true;
}
export const independentContextAdapter: ContextAdapter = {
  async execute(invocations, replies, fault) {
    const result: Observation = { providerRequests: [], decisions: [], interactions: [], unrelatedSkillExecutions: [], providerToolExecutions: [] };
    let previous: unknown;
    let readIndex = 0;
    for (const [index, invocation] of invocations.entries()) {
      const root = copy(invocation.root);
      const target = index === invocations.length - 1;
      const trace = (method: string, data?: unknown) => result.interactions.push({ method, root: copy(root), ...(data === undefined ? {} : { data: copy(data) }) });
      trace("runtime.transition", invocation.transition);
      // Scripted dependency owns raw replies and read effects, never expected observations.
      const source = {
        async getRequiredModelContext(): Promise<unknown> {
          trace("getRequiredModelContext");
          const reply = replies[readIndex++];
          if (!reply || reply.error) {
            trace("context.error");
            throw new Error(reply?.error ?? "Missing scripted source reply");
          }
          let raw = copy(reply.context);
          if (target && fault === "stale-context-reply") raw = copy(previous);
          if (target && valid(raw)) {
            if (fault === "missing-guidance-line") raw.guidance = raw.guidance.split("\n").slice(1).join("\n");
            if (fault === "normalise-line-endings") raw.guidance = raw.guidance.replace(/\r\n|\r/g, "\n");
            if (fault === "unicode-corruption") raw.guidance = raw.guidance.replace("漢", "?");
            if (fault === "missing-required-tool") raw.tools.pop();
            if (fault === "wrong-tool-schema") raw.tools[0].inputSchema = { type: "boolean" };
            if (fault === "wrong-required-description") raw.tools[0].description = "Optional shadow";
          }
          trace("context.reply", raw);
          previous = copy(raw);
          return raw;
        },
      };
      // Capture source method just as the existing private gate does; reassignment is an input attack.
      const read = source.getRequiredModelContext.bind(source);
      if (target && fault === "replace-source-callback") source.getRequiredModelContext = async () => ({ guidance: "OPTIONAL", tools: [] });
      const provider = {
        async stream(request: Request) {
          const observedRoot = target && fault === "wrong-root" ? { ...root, requestId: "foreign-request" } : root;
          const dispatch = () => {
            trace("provider.dispatch", request);
            result.providerRequests.push({ root: copy(observedRoot), request: copy(request) });
          };
          if (target && fault === "finish-before-dispatch") trace("provider.finish");
          if (!(target && fault === "omit-dispatch")) dispatch();
          if (target && fault === "duplicate-dispatch") dispatch();
          if (target && fault === "provider-tool-execution") result.providerToolExecutions.push("audit");
          if (target && fault === "unrelated-skill-execution") result.unrelatedSkillExecutions.push("reddit-publish");
          if (!(target && fault === "finish-before-dispatch")) trace("provider.finish");
        },
      };
      try {
        if (target && fault === "dispatch-before-context") await provider.stream(copy(invocation.request));
        let raw: unknown;
        if (target && fault === "omit-context-read") raw = copy(previous);
        else if (target && fault === "replace-source-callback") raw = await source.getRequiredModelContext();
        else if (target && fault === "duplicate-context-read") {
          // Exercise a second actual dependency call even when the first response throws.
          try { raw = await read(); }
          finally { try { await read(); } catch { /* Preserve the first failure and captured duplicate. */ } }
        } else raw = await read();
        if (!valid(raw)) throw new Error("Invalid required context");
        const names = new Set(raw.tools.map(tool => tool.name));
        const request = copy(invocation.request);
        request.toolExecutionPolicy = "host-only";
        request.systemPrompt = request.systemPrompt ? request.systemPrompt + "\n\n" + raw.guidance : raw.guidance;
        request.tools = [...request.tools.filter(tool => !names.has(tool.name)), ...copy(raw.tools)];
        // A faulty sharing adapter observes mutation through the retained dependency reference.
        if (target && fault === "shared-context-mutation") {
          request.tools = [...request.tools.filter(tool => !names.has(tool.name)), ...raw.tools];
          raw.tools[0].inputSchema.type = "boolean";
        }
        await provider.stream(request);
        result.decisions.push({ root, outcome: "allow" });
      } catch {
        result.decisions.push({ root, outcome: "blocked", diagnostic });
      }
    }
    return result;
  },
};

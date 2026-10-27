// Test-only interaction model. It never receives expected values or case names.
export type Row = { sessionId: string; parentSessionId?: string; metadata?: Record<string, unknown> };
export type Script = { rpcRows?: Row[]; localRows: Row[]; listError?: string; deleteErrors?: string[]; missingDeleteResponse?: string; wrongDeleteResponse?: string };
export type Fault = "none" | "omit-close" | "double-close" | "early-close" | "close-before-settled" | "wrong-count" | "reverse-delete" | "omit-delete" | "allocate-on-rpc";
export type StopInput = { rpcAddress: string; localMatcher: (metadata: Record<string, unknown> | undefined) => boolean; rpcMatcher: (metadata: Record<string, unknown> | undefined) => boolean };
export function createInteractions(script: Script) {
 const effects: string[] = [];
 const stores: { id: string; closed: boolean; closeCount: number }[] = [];
 class Store {
  state = { id: `owned-${stores.length + 1}`, closed: false, closeCount: 0 };
  constructor() { stores.push(this.state); effects.push(`store:new:${this.state.id}`); }
  close() { effects.push(`store:close:${this.state.id}`); this.state.closeCount++; this.state.closed = true; }
 }
 class Service {
  constructor(private store: Store) { effects.push(`service:new:${store.state.id}`); }
  async listSessions(limit: number) {
   effects.push(`local:list:${limit}:${this.store.state.id}`);
   if (this.store.state.closed) throw new Error("store already closed");
   if (script.listError) { effects.push("local:list:throw"); throw new Error(script.listError); }
   effects.push("local:list:ok"); return structuredClone(script.localRows);
  }
  async deleteSession(id: string) {
   effects.push(`local:delete:start:${id}`);
   await Promise.resolve();
   if (this.store.state.closed) { effects.push(`local:delete:closed:${id}`); throw new Error("store already closed"); }
   if (script.missingDeleteResponse === id) { effects.push(`local:delete:missing:${id}`); throw new Error("missing scripted response"); }
   if (script.wrongDeleteResponse === id) { effects.push(`local:delete:response:foreign-${id}`); return; }
   const failed = script.deleteErrors?.includes(id);
   effects.push(`local:delete:${failed ? "throw" : "ok"}:${id}`);
   if (failed) throw new Error(`delete failed:${id}`);
  }
 }
 class Rpc {
  constructor(options: { address: string }) { effects.push(`rpc:new:${options.address}`); }
  async listSessions(options: { limit: number }) {
   effects.push(`rpc:list:${options.limit}`);
   if (!script.rpcRows) { effects.push("rpc:list:throw"); throw new Error("RPC unavailable"); }
   effects.push("rpc:list:ok"); return structuredClone(script.rpcRows);
  }
  async stopRuntimeSession(id: string) { effects.push(`rpc:stop:${id}`); }
  async deleteSession(id: string, force: boolean) { effects.push(`rpc:delete:${id}:${force}`); }
  close() { effects.push("rpc:close"); }
 }
 return { effects, stores, Store, Service, Rpc };
}
export type Interactions = ReturnType<typeof createInteractions>;
// Independent test provider owns resource construction, selection, execution and cleanup.
export async function modelStop(input: StopInput, deps: Interactions, fault: Fault = "none") {
 const rpc = new deps.Rpc({ address: input.rpcAddress });
 try {
  const rows = await rpc.listSessions({ limit: 5000 });
  const matches = rows.filter(row => !row.parentSessionId?.trim() && input.rpcMatcher(row.metadata));
  await Promise.allSettled(matches.map(async row => {
   await rpc.stopRuntimeSession(row.sessionId);
   await rpc.deleteSession(row.sessionId, true);
  }));
  if (fault === "allocate-on-rpc") { const unused = new deps.Store(); unused.close(); }
  return fault === "wrong-count" ? matches.length + 1 : matches.length;
 } catch { /* The existing API falls back only after RPC list failure. */ }
 finally { rpc.close(); }
 const store = new deps.Store();
 const service = new deps.Service(store);
 try {
  if (fault === "early-close") store.close();
  const rows = await service.listSessions(5000);
  let matches = rows.filter(row => !row.parentSessionId?.trim() && input.localMatcher(row.metadata));
  if (fault === "reverse-delete") matches = [...matches].reverse();
  if (fault === "omit-delete") matches = matches.slice(1);
  const deletes = matches.map(row => service.deleteSession(row.sessionId));
  if (fault === "close-before-settled") store.close();
  await Promise.allSettled(deletes);
  return fault === "wrong-count" ? matches.length + 1 : matches.length;
 } finally {
  if (fault !== "omit-close" && fault !== "early-close") store.close();
  if (fault === "double-close") store.close();
 }
}


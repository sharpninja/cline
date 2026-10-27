// SPDX-License-Identifier: Apache-2.0
/** Requirement-derived oracle. This file is never imported by the independent model. */
import type { Event, Expected, Fault, FileState, Identity, Input, Root, Scenario, Step, Store } from "./p1-constructor-isolation-contract";
const copy = <T>(value: T): T => structuredClone(value);
export const rootA: Root = { workspace: "/fixture/work-A", agent: "test-K", session: "synthetic-A", request: "request-A" };
export const rootB: Root = { workspace: "/fixture/work-B", agent: "test-K", session: "synthetic-B", request: "request-B" };
export const identityA: Identity = { root: rootA, distinctId: "test-distinct-A", home: "/fixture/home-A", documents: "/external/redirected-documents-A", state: "/fixture/private-A", discovery: "/fixture/private-A/hub.json", port: 31260, temp: "/fixture/temp-A" };
export const identityB: Identity = { root: rootB, distinctId: "test-distinct-B", home: "/fixture/home-B", documents: "/external/redirected-documents-B", state: "/fixture/private-B", discovery: "/fixture/private-B/hub.json", port: 31261, temp: "/fixture/temp-B" };
export const seeded: FileState[] = [
  { path: "/fixture/home-A/.cline", kind: "directory", bytes: "", owner: "upstream-owner", permissions: "0700", target: null },
  { path: "/fixture/home-A/.cline/data/settings/providers.json", kind: "file", bytes: "UPSTREAM-CANARY\r\n  漢字\\u2014\r\n", owner: "upstream-owner", permissions: "0600", target: null },
  { path: "/external/redirected-documents-A/Cline/Rules", kind: "file", bytes: "DOCUMENTS-CANARY\r  # markdown\n", owner: "documents-owner", permissions: "0440", target: null },
  { path: "/fixture/home-A/.cline/link", kind: "link", bytes: "", owner: "upstream-owner", permissions: "0770", target: "/external/immutable-target" },
];
const e = (root: Root, operation: string, data: unknown): Event => ({ root: copy(root), operation, data: copy(data) });
const direct: Store = { provider: "openai-codex", credential: "test-only-direct-credential", generation: 1 };
const requirements = ["FR-QB-005/AC-QB-013/TEST-QB-013", "FR-QB-006/AC-QB-016/TEST-QB-016", "FR-QB-006/AC-QB-017/TEST-QB-017", "FR-QB-006/AC-QB-018/TEST-QB-018", "FR-QB-018/AC-QB-053/TEST-QB-053", "FR-QB-004/AC-QB-071/TEST-QB-071", "FR-QB-002/AC-QB-072/TEST-QB-072"];
const nativeSteps = ["UC-QB-004.flow-7.step-7", "UC-QB-005.flow-9.step-9", "UC-QB-005.flow-10.step-10"];
const commonControls: Fault[] = ["import-before-initialize", "omit-initialize", "mutable-namespace", "wrong-distinct-id", "wrong-discovery", "wrong-port", "upstream-raw-read", "redirected-documents-read", "omit-raw-read", "duplicate-raw-read", "reorder-constructor", "getter-hides-raw-read", "omit-migration", "omit-custom-load", "omit-configured-register", "omit-permission-hardening", "wrong-recovery-root", "wrong-provider-path", "create-absent-upstream", "extra-file", "omit-cleanup"];
const preservedControls: Fault[] = ["write-upstream", "change-permissions", "change-owner", "change-link", "cleanup-upstream"];
const bootSteps = (context: string): Step[] => ["initialize", "import", "construct", "rawRead", "lastUsed", "getter"].map((op) => ({ op, context }) as Step);
function readEvents(identity: Identity, store: Store, reason: string): Event[] {
  const path = identity.state + "/data/settings/providers.json";
  return [e(identity.root, "fs.exists", { path, exists: true }), e(identity.root, "fs.read", { path }),
    e(identity.root, "provider.rawRead", { path, reason, store }), e(identity.root, "provider.registerConfigured", { store, source: "read" })];
}
// Explicit expected call sequence pinned to existing ClineCore/local-host/store seams. No model execution.
function bootJournal(identity: Identity, store: Store): Event[] {
  const r = identity.root;
  return [e(r, "identity.select", identity), e(r, "namespace.register", { state: identity.state, immutable: true }),
    e(r, "core.import", { state: identity.state }), e(r, "core.create", { distinctId: identity.distinctId, backendMode: "local" }),
    e(r, "provider.migration", { data: identity.state + "/data" }), ...readEvents(identity, store, "migration"),
    e(r, "fs.exists", { path: identity.state + "/data/globalState.json", exists: false }),
    e(r, "fs.exists", { path: identity.state + "/data/secrets.json", exists: false }),
    e(r, "provider.custom.load", { path: identity.state + "/data/settings/models.json" }),
    e(r, "fs.exists", { path: identity.state + "/data/settings/models.json", exists: false }),
    ...readEvents(identity, store, "constructor"), e(r, "provider.registerConfigured", { store, source: "constructor" }),
    e(r, "fs.exists", { path: identity.state + "/data/settings/providers.json", exists: true }),
    e(r, "fs.chmod.attempt", { path: identity.state + "/data/settings/providers.json", mode: 0o600 }),
    e(r, "oauth.construct", { providerSettingsPath: identity.state + "/data/settings/providers.json" }),
    e(r, "detached.recover", { temp: identity.temp }), ...readEvents(identity, store, "explicit-read"),
    ...readEvents(identity, store, "last-used"), e(r, "provider.lastUsed", { provider: store.provider }),
    ...(["cline", "cline-pass", "cline-cloud"].includes(store.provider) ? [] : readEvents(identity, store, "getter")),
    e(r, "provider.get", { provider: store.provider, value: ["cline", "cline-pass", "cline-cloud"].includes(store.provider) ? null : store })];
}
const finishJournal = (identity: Identity, outcome: string): Event[] => [e(identity.root, "cleanup.owned", { state: identity.state }), e(identity.root, "terminal", { outcome })];
const baseExpected = (journal: Event[], external: FileState[], stores: Record<string, Store>, terminals: Expected["terminals"], results: Expected["results"] = []): Expected => ({ journal, external: copy(external), privateStores: copy(stores), results, terminals });
export const constructorScenarios: Scenario[] = [];
for (const topology of ["absent", "seeded"] as const) {
  for (const reply of ["ok", "assertion-failure", "timeout", "cancel"] as const) {
    const external = topology === "seeded" ? seeded : [];
    const outcome = reply === "ok" ? "success" : reply;
    const input: Input = { identities: { A: copy(identityA) }, stores: { A: copy(direct) }, external: copy(external), steps: [...bootSteps("A"), { op: "request", context: "A", reply }, { op: "finish", context: "A" }] };
    const journal = [...bootJournal(identityA, direct), e(rootA, "provider.select", { provider: direct.provider }),
      e(rootA, "network.request", { provider: direct.provider, endpoint: "https://direct.test/openai-codex", credential: direct.credential }),
      e(rootA, "network.reply", { reply }), ...finishJournal(identityA, outcome)];
    constructorScenarios.push({ id: topology + "/" + outcome, requirements, nativeSteps, input,
      expected: baseExpected(journal, external, { A: direct }, [{ root: rootA, outcome }]),
      controls: [...commonControls, ...(topology === "seeded" ? preservedControls : []), "wrong-provider", "omit-request", "duplicate-request", "wrong-request-root", ...(reply !== "ok" ? ["wrong-terminal" as Fault] : [])] });
  }
}
for (const variant of ["missing", "invalid", "cline", "cline-pass", "cline-cloud"] as const) {
  const provider = variant === "missing" || variant === "invalid" ? "openai-codex" : variant;
  const store: Store = { provider, credential: variant === "missing" ? null : "test-only-excluded-or-invalid", generation: 1 };
  const reply = variant === "invalid" ? "invalid" : "ok";
  const reason = provider === "openai-codex" ? "direct-provider-credentials-required" : "prohibited-provider";
  const outcome = "blocked";
  const input: Input = { identities: { A: copy(identityA) }, stores: { A: copy(store) }, external: copy(seeded), steps: [...bootSteps("A"), { op: "request", context: "A", reply }, { op: "finish", context: "A" }] };
  const journal = [...bootJournal(identityA, store), e(rootA, "provider.select", { provider }), e(rootA, "provider.reject", { reason }), ...finishJournal(identityA, outcome)];
  constructorScenarios.push({ id: "no-fallback/" + variant, requirements, nativeSteps, input,
    expected: baseExpected(journal, seeded, { A: store }, [{ root: rootA, outcome }]),
    controls: [...commonControls, ...preservedControls, "cloud-fallback", "wrong-provider", "wrong-terminal"] });
}
for (const variant of ["concurrent-refresh", "signout-before-reply", "late-A-unaffected-B"] as const) {
  const expired: Store = { provider: "openai-codex", credential: "expired:test-only-A", generation: 1 };
  const signedOut = variant !== "concurrent-refresh";
  const parallel = variant === "late-A-unaffected-B";
  const finalA: Store = { provider: "openai-codex", credential: signedOut ? null : "rotated:test-only-A", generation: 2 };
  const steps: Step[] = [...bootSteps("A"), ...(parallel ? bootSteps("B") : []), { op: "resolve", context: "A", call: "waiter-1" }, { op: "resolve", context: "A", call: "waiter-2" }];
  const journal = [...bootJournal(identityA, expired), ...(parallel ? bootJournal(identityB, direct) : []),
    e(rootA, "oauth.resolve", { call: "waiter-1" }), e(rootA, "oauth.refresh.start", { credential: expired.credential, generation: 1 }), e(rootA, "oauth.resolve", { call: "waiter-2" })];
  const results: Expected["results"] = [];
  if (signedOut) { steps.push({ op: "signOut", context: "A" }); journal.push(e(rootA, "provider.signOut", { generation: 2 })); }
  if (parallel) {
    steps.push({ op: "resolve", context: "B", call: "unaffected-B" });
    journal.push(e(rootB, "oauth.resolve", { call: "unaffected-B" }));
    results.push({ root: rootB, call: "unaffected-B", credential: direct.credential });
  }
  steps.push({ op: "refresh", context: "A", credential: "rotated:test-only-A" });
  journal.push(e(rootA, "oauth.refresh.reply", { credential: "rotated:test-only-A" }),
    signedOut ? e(rootA, "oauth.staleReplyIgnored", { generation: 1 }) : e(rootA, "provider.persist", { state: identityA.state, store: finalA }));
  results.push({ root: rootA, call: "waiter-1", credential: finalA.credential }, { root: rootA, call: "waiter-2", credential: finalA.credential });
  const terminalA = signedOut ? "signed-out" : "success";
  steps.push({ op: "finish", context: "A" }); journal.push(...finishJournal(identityA, terminalA));
  if (parallel) { steps.push({ op: "finish", context: "B" }); journal.push(...finishJournal(identityB, "success")); }
  const stores: Record<string, Store> = parallel ? { A: copy(expired), B: copy(direct) } : { A: copy(expired) };
  const finalStores: Record<string, Store> = parallel ? { A: finalA, B: direct } : { A: finalA };
  constructorScenarios.push({ id: "oauth/" + variant, requirements, nativeSteps,
    input: { identities: parallel ? { A: copy(identityA), B: copy(identityB) } : { A: copy(identityA) }, stores, external: copy(seeded), steps },
    expected: baseExpected(journal, seeded, finalStores, parallel ? [{ root: rootA, outcome: terminalA }, { root: rootB, outcome: "success" }] : [{ root: rootA, outcome: terminalA }], results),
    controls: [...commonControls, ...preservedControls, "omit-refresh", "duplicate-refresh", "omit-waiter", ...(signedOut ? ["restore-after-signout" as Fault] : ["stale-refresh" as Fault]), ...(parallel ? ["rebind-late-callback" as Fault] : [])] });
}










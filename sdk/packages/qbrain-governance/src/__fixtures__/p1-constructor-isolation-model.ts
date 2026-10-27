// SPDX-License-Identifier: Apache-2.0
/** Independent test-only state/dependency model. Imports no expected fixtures or production code. */
import type { Adapter, Event, Fault, FileState, Identity, Input, Observation, Root, Store } from "./p1-constructor-isolation-contract";
const clone = <T>(value: T): T => structuredClone(value);
const prohibited = (provider: string) => ["cline", "cline-pass", "cline-cloud"].includes(provider);
export const independentConstructorAdapter: Adapter = {
  async execute(input: Input, fault?: Fault): Promise<Observation> {
    const journal: Event[] = [];
    const external = clone(input.external);
    const stores = clone(input.stores);
    const results: Observation["results"] = [];
    const terminals: Observation["terminals"] = [];
    const outcomes = new Map<string, string>();
    const exercisedFaults: string[] = [];
    const namespaces = new Map<string, Readonly<{ state: string; home: string }>>();
    const pending = new Map<string, { generation: number; root: Root; waiters: string[] }>();
    const hit = (name: Fault) => {
      if (fault !== name) return false;
      if (!exercisedFaults.includes(name)) exercisedFaults.push(name);
      return true;
    };
    const trace = (root: Root, operation: string, data: unknown) => journal.push({ root: clone(root), operation, data: clone(data) });
    // Filesystem dependency owns inventory and captures operations, including prohibited attempts.
    const fs = {
      read(root: Root, path: string) { trace(root, "fs.read", { path }); },
      write(root: Root, path: string, bytes: string) {
        trace(root, "fs.write", { path, bytes });
        const file = external.find((entry) => entry.path === path);
        if (file) file.bytes = bytes;
        else external.push({ path, kind: "file", bytes, owner: "fixture", permissions: "0600", target: null });
      },
      metadata(root: Root, file: FileState, field: "owner" | "permissions" | "target", value: string) {
        trace(root, "fs." + field, { path: file.path, value }); file[field] = value;
      },
    };
    const rawRead = (context: string, identity: Identity, reason: string) => {
      const path = (namespaces.get(context)?.state ?? identity.home + "/.cline") + (hit("wrong-provider-path") ? "/data/provider-settings.json" : "/data/settings/providers.json");
      if (hit("upstream-raw-read")) fs.read(identity.root, identity.home + "/.cline/data/settings/providers.json");
      if (hit("redirected-documents-read")) fs.read(identity.root, identity.documents + "/Cline/Rules");
      if (hit("omit-raw-read")) return clone(stores[context]!);
      const read = () => {
        trace(identity.root, "fs.exists", { path, exists: true });
        fs.read(identity.root, path);
        trace(identity.root, "provider.rawRead", { path, reason, store: stores[context] });
        trace(identity.root, "provider.registerConfigured", { store: stores[context], source: "read" });
      };
      read(); if (hit("duplicate-raw-read")) read();
      return clone(stores[context]!);
    };
    for (const step of input.steps) {
      const identity = clone(input.identities[step.context]!);
      const root = identity.root;
      const store = stores[step.context]!;
      switch (step.op) {
        case "initialize": {
          if (hit("import-before-initialize")) trace(root, "core.import", { state: identity.home + "/.cline" });
          if (hit("omit-initialize")) break;
          if (hit("wrong-distinct-id")) identity.distinctId = "operator-machine";
          if (hit("wrong-discovery")) identity.discovery = "/external/operator/discovery.json";
          if (hit("wrong-port")) identity.port++;
          trace(root, "identity.select", identity);
          const record = { state: identity.state, home: identity.home };
          const selected = hit("mutable-namespace") ? record : Object.freeze(record);
          namespaces.set(step.context, selected);
          trace(root, "namespace.register", { state: selected.state, immutable: Object.isFrozen(selected) });
          break;
        }
        case "import": trace(root, "core.import", { state: namespaces.get(step.context)?.state ?? identity.home + "/.cline" }); break;
        case "construct": {
          trace(root, "core.create", { distinctId: hit("wrong-distinct-id") ? "operator-machine" : identity.distinctId.trim(), backendMode: "local" });
          const state = namespaces.get(step.context)?.state ?? identity.home + "/.cline";
          const oauth = () => trace(root, "oauth.construct", { providerSettingsPath: state + "/data/settings/providers.json" });
          if (hit("reorder-constructor")) oauth();
          // Default no-options manager infers data from settings/providers.json. Private legacy files are absent in these inputs.
          if (!hit("omit-migration")) {
            trace(root, "provider.migration", { data: state + "/data" });
            rawRead(step.context, identity, "migration");
            for (const name of ["globalState.json", "secrets.json"])
              trace(root, "fs.exists", { path: state + "/data/" + name, exists: false });
          }
          if (!hit("omit-custom-load")) {
            const modelsPath = state + "/data/settings/models.json";
            trace(root, "provider.custom.load", { path: modelsPath });
            trace(root, "fs.exists", { path: modelsPath, exists: false });
          }
          if (hit("getter-hides-raw-read")) trace(root, "provider.get", { provider: store.provider, value: prohibited(store.provider) ? null : store });
          else rawRead(step.context, identity, "constructor");
          if (!hit("omit-configured-register")) trace(root, "provider.registerConfigured", { store, source: "constructor" });
          const providerPath = state + "/data/settings/providers.json";
          trace(root, "fs.exists", { path: providerPath, exists: true });
          if (!hit("omit-permission-hardening")) trace(root, "fs.chmod.attempt", { path: providerPath, mode: 0o600 });
          if (fault !== "reorder-constructor") oauth();
          trace(root, "detached.recover", { temp: hit("wrong-recovery-root") ? state + "/sessions" : identity.temp });
          if (hit("write-upstream")) {
            const file = external.find((entry) => entry.kind === "file");
            if (file) fs.write(root, file.path, file.bytes + "changed");
          }
          if (hit("create-absent-upstream")) fs.write(root, identity.home + "/.cline/data/settings/providers.json", "created");
          break;
        }
        case "rawRead": rawRead(step.context, identity, "explicit-read"); break;
        case "lastUsed": {
          const value = rawRead(step.context, identity, "last-used");
          trace(root, "provider.lastUsed", { provider: value.provider }); break;
        }
        case "getter": {
          if (!prohibited(store.provider)) rawRead(step.context, identity, "getter");
          trace(root, "provider.get", { provider: store.provider, value: prohibited(store.provider) ? null : store }); break;
        }
        case "request": {
          let provider = store.provider;
          if (hit("wrong-provider")) provider = "unexpected-direct";
          trace(root, "provider.select", { provider });
          if (prohibited(provider) || !store.credential || step.reply === "invalid") {
            outcomes.set(step.context, "blocked");
            trace(root, "provider.reject", { reason: prohibited(provider) ? "prohibited-provider" : "direct-provider-credentials-required" });
            if (hit("cloud-fallback")) trace(root, "network.request", { provider: "cline", endpoint: "https://api.cline.bot", credential: "excluded" });
            break;
          }
          const dispatch = () => {
            const dispatchRoot = hit("wrong-request-root") ? { ...root, request: "replacement-request" } : root;
            trace(dispatchRoot, "network.request", { provider, endpoint: "https://direct.test/" + provider, credential: store.credential });
          };
          if (!hit("omit-request")) dispatch();
          if (hit("duplicate-request")) dispatch();
          // Scripted dependency reply is an input. No expected outcome is supplied to this model.
          trace(root, "network.reply", { reply: step.reply });
          outcomes.set(step.context, step.reply === "ok" ? "success" : step.reply);
          break;
        }
        case "resolve": {
          trace(root, "oauth.resolve", { call: step.call });
          if (!store.credential?.startsWith("expired:")) {
            results.push({ root: clone(root), call: step.call, credential: store.credential });
            outcomes.set(step.context, store.credential === null ? "credentials-required" : "success"); break;
          }
          let refresh = pending.get(step.context);
          if (!refresh) {
            refresh = { generation: store.generation, root: clone(root), waiters: [] };
            pending.set(step.context, refresh);
            if (!hit("omit-refresh")) trace(root, "oauth.refresh.start", { credential: store.credential, generation: store.generation });
            if (hit("duplicate-refresh")) trace(root, "oauth.refresh.start", { credential: store.credential, generation: store.generation });
          }
          refresh.waiters.push(step.call); break;
        }
        case "signOut": {
          store.credential = null; store.generation++;
          outcomes.set(step.context, "signed-out");
          trace(root, "provider.signOut", { generation: store.generation }); break;
        }
        case "refresh": {
          const refresh = pending.get(step.context);
          if (!refresh) { trace(root, "oauth.unexpectedReply", { credential: step.credential }); break; }
          const other = Object.keys(input.identities).find((key) => key !== step.context);
          const callbackRoot = hit("rebind-late-callback") && other ? input.identities[other]!.root : refresh.root;
          trace(callbackRoot, "oauth.refresh.reply", { credential: step.credential });
          const current = store.generation === refresh.generation && store.credential !== null;
          if (current || hit("restore-after-signout")) {
            store.credential = hit("stale-refresh") ? "expired:stale" : step.credential;
            store.generation++;
            outcomes.set(step.context, "success");
            trace(callbackRoot, "provider.persist", { state: identity.state, store });
          } else {
            outcomes.set(step.context, "signed-out");
            trace(refresh.root, "oauth.staleReplyIgnored", { generation: refresh.generation });
          }
          for (const call of refresh.waiters) {
            if (hit("omit-waiter") && call === refresh.waiters.at(-1)) continue;
            results.push({ root: clone(callbackRoot), call, credential: store.credential });
          }
          pending.delete(step.context); break;
        }
        case "finish": {
          const file = external.find((entry) => entry.kind === "file");
          const link = external.find((entry) => entry.kind === "link");
          if (hit("change-permissions") && file) fs.metadata(root, file, "permissions", "0777");
          if (hit("change-owner") && file) fs.metadata(root, file, "owner", "replacement");
          if (hit("change-link") && link) fs.metadata(root, link, "target", identity.state);
          if (hit("extra-file")) fs.write(root, identity.documents + "/Cline/extra", "extra");
          if (hit("cleanup-upstream")) {
            trace(root, "fs.remove", { path: identity.home + "/.cline" }); external.splice(0);
          }
          if (!hit("omit-cleanup")) trace(root, "cleanup.owned", { state: identity.state });
          const outcome = hit("wrong-terminal") ? "success" : (outcomes.get(step.context) ?? "incomplete");
          terminals.push({ root: clone(root), outcome }); trace(root, "terminal", { outcome });
          break;
        }
      }
    }
    return { journal, external, privateStores: stores, results, terminals, exercisedFaults };
  },
};










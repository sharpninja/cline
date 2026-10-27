// SPDX-License-Identifier: Apache-2.0
// Independent input-only test model; no expected objects, scenario names or production imports.
import type { Dependencies, Operation, Pair, Provider } from "./p1-desktop-admission.contract.fixture";
const cloud = (id: string) => ["cline", "cline-pass", "cline-cloud"].includes(id.trim().toLowerCase());
function unit(raw: Record<string, unknown>, borrow: boolean): Pair | null {
  const structured = Object.hasOwn(raw, "modelSelection");
  const selected = structured ? raw.modelSelection : { providerId: raw.provider, modelId: raw.model };
  if (!selected || typeof selected !== "object" || Array.isArray(selected)) {
    return borrow ? unit({ provider: raw.provider, model: raw.model }, false) : null;
  }
  const value = selected as Record<string, unknown>;
  const providerId = typeof value.providerId === "string" ? value.providerId.trim() : "";
  const modelId = typeof value.modelId === "string" ? value.modelId.trim() : "";
  if ((!providerId || !modelId) && borrow) return unit({ provider: raw.provider, model: raw.model }, false);
  return providerId && modelId ? { providerId, modelId } : null;
}
export function createAdmissionModel(defect = "none"): Provider {
  return async (input: Operation, deps: Dependencies) => {
    const fallback = { providerId: "direct-a", modelId: "model-a" };
    const reject = async () => {
      deps.diagnose("Select a permitted direct provider/model in Settings; verify catalog and session.");
      if (defect === "mutate-blocked") await deps.commit(input.kind, fallback, input.context);
    };
    if (input.kind === "cancel") {
      if (defect === "mutate-cancel") await deps.commit(input.kind, fallback, input.context);
      return;
    }
    if (input.target === "cloud" && defect !== "allow-hosted-target") { await reject(); return; }
    if (defect === "commit-before-catalog") await deps.commit(input.kind, fallback, input.context);
    const catalog = await deps.catalog();
    const validCatalog = !!catalog && typeof catalog === "object" && Array.isArray(catalog.providers) &&
      catalog.providers.every((p) => p && typeof p.id === "string" && typeof p.enabled === "boolean" && Array.isArray(p.models) && p.models.every((m) => typeof m === "string"));
    if (!validCatalog) {
      if (defect === "accept-malformed-catalog") await deps.commit(input.kind, fallback, input.context);
      else await reject();
      return;
    }
    if (catalog.context !== input.context && defect !== "ignore-context") { await reject(); return; }
    if (catalog.status !== "ready" && defect !== "ignore-catalog-state") { await reject(); return; }
    let selected = unit(input.raw, defect === "borrow-legacy");
    if (defect === "accept-invalid-pair" && !selected) selected = fallback;
    if (!selected) { await reject(); return; }
    if (cloud(selected.providerId) && defect !== "allow-hosted") { await reject(); return; }
    if (input.rememberedExplicit === false && defect !== "invent-provenance") { await reject(); return; }
    const provider = catalog.providers.find((entry) => entry.id === selected!.providerId);
    if (((input.kind !== "onboard" && !provider?.enabled) || !provider?.models.includes(selected.modelId)) && defect !== "accept-invalid-pair") { await reject(); return; }
    if (input.hostedHistory && !input.explicitNewSession && defect !== "reinterpret-history") { await reject(); return; }
    if (input.kind === "onboard") {
      if (!provider?.keyOnly && defect !== "ignore-form-compatibility") { await reject(); return; }
      if (defect === "advance-before-save") deps.advance();
      const saved = defect === "omit-save" ? true : await deps.save(selected);
      if (!saved && defect !== "ignore-save-failure") { await reject(); return; }
    }
    if (defect === "wrong-pair") selected = { providerId: "direct-b", modelId: "model-b" };
    if (defect !== "omit-commit") await deps.commit(input.kind, selected, defect === "wrong-context" ? "ctx-b" : input.context);
    if (defect === "duplicate-commit") await deps.commit(input.kind, selected, input.context);
    if (input.kind === "onboard" && defect !== "advance-before-save") deps.advance();
  };
}

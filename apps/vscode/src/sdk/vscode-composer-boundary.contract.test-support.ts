// SPDX-License-Identifier: Apache-2.0
// FR-QB-003 AC-QB-069 TEST-QB-069, partial raw composer handoff only.
// AC-QB-005/007/013 and UC-QB-003 steps5/31/32 remain open.
import assert from "node:assert/strict";
export type Snapshot = { text: string; images: string[]; files: string[]; quote: string | null };
export type Callback = (text: string, images: string[], files: string[]) => Promise<void>;
export type Boundary = { render(input: Snapshot): void; submit(): Promise<void> };
export type Factory = (callback: Callback) => Boundary;
export type Fault = "none" | "trim" | "drop" | "duplicate" | "replace-promise" | "drop-images" | "drop-files" | "swap" | "quote" | "stale";
type Case = { name: string; steps: Snapshot[]; pending?: boolean; reject?: boolean; renderBefore?: Snapshot };
const raw = "  ## raw\r\n\t\u96ea \u{1f642} **request**\n\n";
const full = (): Snapshot => ({ text: raw, images: ["synthetic:image-a", "synthetic:image-b"], files: ["synthetic/file-a.ts", "synthetic/file-b.ts"], quote: null });
export const cases: readonly Case[] = [
  { name: "raw-crlf-unicode-attachments", steps: [full()] },
  { name: "empty-text-with-attachments", steps: [{ ...full(), text: "" }] },
  { name: "whitespace-is-not-normalized-here", steps: [{ text: " \r\n\t ", images: [], files: [], quote: null }] },
  { name: "quote-remains-outside-raw-handoff", steps: [{ text: raw, images: [], files: [], quote: "synthetic quoted context" }] },
  { name: "rerender-forwards-current-draft", renderBefore: { ...full(), text: "earlier draft" }, steps: [full()] },
  { name: "equal-text-separate-submissions", steps: [full(), full()] },
  { name: "pending-handler-promise-preserved", steps: [full()], pending: true },
  { name: "handler-rejection-promise-preserved", steps: [full()], reject: true },
];
export function controlsFor(c: Case): Fault[] {
  const input = c.steps[0];
  const out: Fault[] = ["drop", "duplicate", "replace-promise"];
  if (input.text !== input.text.trim()) out.push("trim");
  if (input.images.length) out.push("drop-images");
  if (input.files.length) out.push("drop-files");
  if (input.images.length && input.files.length) out.push("swap");
  if (input.quote) out.push("quote");
  if (c.renderBefore) out.push("stale");
  return out;
}
export async function assertComposer(c: Case, factory: Factory) {
  const calls: { text: string; images: string[]; files: string[] }[] = [];
  const journal: unknown[] = [], releases: ReturnType<typeof Promise.withResolvers<void>>[] = [];
  const outstanding: Promise<unknown>[] = [];
  let response: ReturnType<typeof Promise.withResolvers<void>>;
  const scriptError = new Error("synthetic handler rejection");
  const boundary = factory((text, images, files) => {
    calls.push({ text, images: [...images], files: [...files] });
    journal.push({ effect: "handler", text, images: [...images], files: [...files] });
    return response.promise;
  });
  try {
    if (c.renderBefore) { boundary.render(c.renderBefore); journal.push({ effect: "render", input: structuredClone(c.renderBefore) }); }
    for (const [index, input] of c.steps.entries()) {
      boundary.render(input); journal.push({ effect: "render", input: structuredClone(input) });
      response = Promise.withResolvers<void>(); releases.push(response); outstanding.push(response.promise);
      let scriptSettled = false;
      response.promise.then(() => { scriptSettled = true; }, () => { scriptSettled = true; });
      if (!c.pending) { if (c.reject) response.reject(scriptError); else response.resolve(); }
      const returned = boundary.submit(); if (returned) outstanding.push(returned);
      const samePromise = returned === response.promise;
      journal.push({ effect: "returned", samePromise });
      assert.equal(calls.length, index + 1, "composer-call-count");
      const call = calls[index];
      assert.equal(call.text, input.text, "composer-raw-text");
      assert.deepStrictEqual(call.images, input.images, "composer-images");
      assert.deepStrictEqual(call.files, input.files, "composer-files");
      assert.strictEqual(returned, response.promise, "composer-handler-promise");
      // No waiting for a pending scripted callback is required to observe the raw handoff.
      await Promise.resolve();
      assert.equal(scriptSettled, !c.pending, "composer-scripted-promise-state");
      journal.push({ effect: "scripted-response-state", settled: scriptSettled });
      if (c.pending) response.resolve();
      let caught: unknown;
      try { await returned; } catch (error) { caught = error; }
      assert.strictEqual(caught, c.reject ? scriptError : undefined, "composer-handler-error");
    }
    return { name: c.name, calls, journal, pendingInput: !!c.pending, rejectionInput: !!c.reject,
      level: "synthetic-raw-composer-callback-only", durableAudit: false, nativeHost: false };
  } catch (error) {
    if (error instanceof assert.AssertionError) Object.assign(error, { interactionEvidence: {
      name: c.name, calls: structuredClone(calls), journal: structuredClone(journal),
      inputs: structuredClone(c.steps), renderBefore: c.renderBefore ? structuredClone(c.renderBefore) : null,
    } });
    throw error;
  } finally { for (const release of releases) release.resolve(); await Promise.allSettled(outstanding); }
}
export function qualify(error: unknown, fault: Fault): boolean {
  if (!(error instanceof assert.AssertionError)) return false;
  const e = (error as assert.AssertionError & { interactionEvidence?: { calls: Snapshot[]; inputs: Snapshot[]; journal: { effect: string; samePromise?: boolean }[]; renderBefore: Snapshot | null } }).interactionEvidence;
  if (!e || !e.inputs.length) return false;
  const call = e.calls[0], input = e.inputs[0];
  const spec: Partial<Record<Fault, [string, string, boolean]>> = {
    drop: ["composer-call-count", "strictEqual", e.calls.length === 0],
    duplicate: ["composer-call-count", "strictEqual", e.calls.length === 2],
    trim: ["composer-raw-text", "strictEqual", !!call && call.text !== input.text && call.text === input.text.trim()],
    "drop-images": ["composer-images", "deepStrictEqual", !!call && call.images.length === 0 && input.images.length > 0],
    "drop-files": ["composer-files", "deepStrictEqual", !!call && call.files.length === 0 && input.files.length > 0],
    swap: ["composer-images", "deepStrictEqual", !!call && JSON.stringify(call.images) === JSON.stringify(input.files) && JSON.stringify(input.images) !== JSON.stringify(input.files)],
    quote: ["composer-raw-text", "strictEqual", !!call && !!input.quote && call.text === input.quote + "\n" + input.text],
    stale: ["composer-raw-text", "strictEqual", !!call && !!e.renderBefore && call.text === e.renderBefore.text && call.text !== input.text],
    "replace-promise": ["composer-handler-promise", "strictEqual", e.journal.some(x => x.effect === "returned" && x.samePromise === false)],
  };
  const expected = spec[fault];
  return !!expected && error.message.split("\n", 1)[0] === expected[0] && error.operator === expected[1] && expected[2];
}


// SPDX-License-Identifier: Apache-2.0
// Input-only test model. No expected objects, production imports, SDK, network or storage.
import type { Callback, Factory, Fault, Snapshot } from "./vscode-composer-boundary.contract.test-support";
export function model(fault: Fault = "none"): Factory {
  return (callback: Callback) => {
    let current: Snapshot | undefined, first: Snapshot | undefined;
    return {
      render(input) { current = input; first ??= input; },
      submit() {
        if (!current) throw new Error("render required before submit");
        const source = fault === "stale" ? first! : current;
        if (fault === "drop") return Promise.resolve();
        const text = fault === "trim" ? source.text.trim() :
          fault === "quote" && source.quote ? source.quote + "\n" + source.text : source.text;
        const images = fault === "drop-images" ? [] : fault === "swap" ? source.files : source.images;
        const files = fault === "drop-files" ? [] : fault === "swap" ? source.images : source.files;
        const result = callback(text, images, files);
        if (fault === "duplicate") callback(text, images, files);
        return fault === "replace-promise" ? result.then(() => undefined) : result;
      },
    };
  };
}

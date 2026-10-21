// SPDX-License-Identifier: Apache-2.0
const originalSetTimeout = globalThis.setTimeout
globalThis.setTimeout = (callback, milliseconds, ...args) => {
  console.log("QB_E2E_EVENT " + JSON.stringify({ kind: "deadline", milliseconds }))
  return originalSetTimeout(callback, process.env.QB_E2E_FAILURE === "timeout" ? 0 : milliseconds, ...args)
}

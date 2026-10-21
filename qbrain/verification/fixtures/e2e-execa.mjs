// SPDX-License-Identifier: Apache-2.0
export async function execa(program, args, options) {
  console.log("QB_E2E_EVENT " + JSON.stringify({ kind: "installer", program, args, stdio: options.stdio }))
  if (process.env.QB_E2E_FAILURE === "installer") throw new Error("MOCK_INSTALLER_FAILURE")
  if (process.env.QB_E2E_FAILURE === "timeout") return new Promise(() => {})
  return { exitCode: 0 }
}

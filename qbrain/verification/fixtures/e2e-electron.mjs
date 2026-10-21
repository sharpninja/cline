// SPDX-License-Identifier: Apache-2.0
export class SilentReporter {}
export async function downloadAndUnzipVSCode(version, platform, reporter) {
  console.log("QB_E2E_EVENT " + JSON.stringify({ kind: "download", version, platform: platform ?? null, silent: reporter instanceof SilentReporter }))
  if (process.env.QB_E2E_FAILURE === "download") throw new Error("MOCK_DOWNLOAD_FAILURE")
  if (process.env.QB_E2E_FAILURE === "timeout") return new Promise(() => {})
  return "/synthetic/vscode"
}

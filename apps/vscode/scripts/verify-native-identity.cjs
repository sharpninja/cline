// SPDX-License-Identifier: Apache-2.0
/* Run with VS Code --extensionTestsPath and an isolated --user-data-dir; do not redirect HOME.
 * Verifies native registration and actual sidebar activation; browser origin/state
 * isolation requires a separate webview test and is not claimed by this probe.
 */
const assert = require("node:assert/strict")
const vscode = require("vscode")
exports.run = async function () {
 // biome-ignore lint/plugin/vscode-api: Native integration probe must inspect the real extension registry.
 const extension = vscode.extensions.getExtension("sharpninja.cline-qb")
 assert.ok(extension, "Private extension missing from native extension registry")
 assert.equal(extension.packageJSON.displayName, "cline-qb")
 // biome-ignore lint/plugin/vscode-api: Native integration probe must prove upstream identity is absent from its isolated profile.
 assert.equal(vscode.extensions.getExtension("saoudrizwan.claude-dev"), undefined, "Upstream extension unexpectedly installed in isolated profile")
 await extension.activate()
 assert.equal(extension.isActive, true)
 const commands = await vscode.commands.getCommands(true)
 for (const {command} of extension.packageJSON.contributes.commands) {
  if (command.includes(".dev.")) continue // production builds intentionally omit dev commands
  assert.ok(commands.includes(command), `Unregistered manifest command: ${command}`)
 }
 assert.ok(!commands.includes("cline.plusButtonClicked"), "Upstream command registered")
 // biome-ignore lint/plugin/vscode-api: Exercise actual registered command routing rather than a mocked host bridge.
 await vscode.commands.executeCommand("cline-qb.SidebarProvider.focus")
 // biome-ignore lint/plugin/vscode-api: Exercise actual registered command routing rather than a mocked host bridge.
 await vscode.commands.executeCommand("cline-qb.plusButtonClicked")
 // biome-ignore lint/plugin/vscode-api: Exercise the real registered virtual-document provider.
 const doc = await vscode.workspace.openTextDocument(vscode.Uri.from({scheme:"cline-qb-diff", path:"/private.txt", query:Buffer.from("private content").toString("base64")}))
 assert.equal(doc.getText(), "private content")
 console.log("QB_NATIVE_IDENTITY_PASS: private extension, command routing, sidebar activation, virtual document provider")
}

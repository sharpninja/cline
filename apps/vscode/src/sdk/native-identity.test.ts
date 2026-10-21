// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from "vitest"
import manifest from "../../package.json"
import { ExtensionRegistryInfo } from "../registry"
import { getIdeRedirectUri } from "../hosts/vscode/hostbridge/env/getIdeRedirectUri"
import { openWalkthrough } from "../core/controller/ui/openWalkthrough"
import * as vscode from "vscode"
vi.mock("vscode", () => ({ env: { uiKind: 1, uriScheme: "vscode" }, UIKind: { Web: 2 }, commands: { executeCommand: vi.fn() } }))
vi.mock("../services/telemetry", () => ({ telemetryService: { captureButtonClick: vi.fn() } }))
vi.mock("../hosts/host-provider", () => ({ HostProvider: {} }))
beforeEach(() => {
	vi.clearAllMocks()
	Object.assign(vscode.env, { uiKind: 1, uriScheme: "vscode" })
})
describe("AC-QB-053 private VS Code native identity", () => {
	it("keeps global context and icon consumers bound to private identifiers", () => {
		expect(ExtensionRegistryInfo.contextKeys).toEqual({
			isDevMode: "cline-qb.isDevMode",
			isGeneratingCommit: "cline-qb.isGeneratingCommit",
		})
		expect(ExtensionRegistryInfo.icon).toBe("cline-qb-icon")
		for (const command of manifest.contributes.commands)
			expect(Object.values(ExtensionRegistryInfo.commands)).toContain(command.command)
	})
	it("separates native storage ownership from upstream", () => {
		expect(ExtensionRegistryInfo.id).toBe("sharpninja.cline-qb")
		expect(manifest.displayName).toBe("cline-qb")
	})
	it("registers a private sidebar and every menu targets it", () => {
		expect(ExtensionRegistryInfo.views.Sidebar).toBe("cline-qb.SidebarProvider")
		expect(manifest.contributes.viewsContainers.activitybar[0].id).toBe("cline-qb-ActivityBar")
		expect((manifest.contributes.views as Record<string, { id: string }[]>)["cline-qb-ActivityBar"][0].id).toBe(
			ExtensionRegistryInfo.views.Sidebar,
		)
		for (const item of manifest.contributes.menus["view/title"])
			expect(item.when).toBe(`view == ${ExtensionRegistryInfo.views.Sidebar}`)
	})
	it("keeps declared commands, menus and keybindings in the private namespace", () => {
		const declared = new Set(manifest.contributes.commands.map((c) => c.command))
		for (const command of declared) expect(command).toMatch(/^cline-qb\./)
		for (const command of Object.values(ExtensionRegistryInfo.commands)) expect(command).toMatch(/^cline-qb\./)
		for (const item of [...manifest.contributes.keybindings, ...Object.values(manifest.contributes.menus).flat()])
			expect(declared.has(item.command)).toBe(true)
	})
	it("isolates global context keys and icon registrations", () => {
		expect(JSON.stringify(manifest.contributes)).not.toMatch(/cline\.(isDevMode|isGeneratingCommit)/)
		expect(Object.keys(manifest.contributes.icons)).toEqual(["cline-qb-icon"])
	})
	it.each([
		"vscode",
		"vscode-insiders",
		"cursor",
		"",
	])("redirects native %s callbacks to the installed private extension", async (scheme) => {
		Object.assign(vscode.env, { uriScheme: scheme })
		expect(await getIdeRedirectUri({})).toEqual({ value: `${scheme || "vscode"}://sharpninja.cline-qb` })
	})
	it("preserves web authentication without opening a native app", async () => {
		Object.assign(vscode.env, { uiKind: 2 })
		expect(await getIdeRedirectUri({})).toEqual({ value: "" })
	})
	it("opens the walkthrough owned by this extension", async () => {
		await openWalkthrough(undefined as any, {})
		expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
			"workbench.action.openWalkthrough",
			"sharpninja.cline-qb#ClineWalkthrough",
		)
	})
})

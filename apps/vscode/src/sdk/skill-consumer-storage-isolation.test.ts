// SPDX-License-Identifier: Apache-2.0
import { toggleSkill } from "../core/controller/file/toggleSkill"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { registerStorageNamespace, setHomeDir } from "@cline/shared/storage"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { createQbrainStorageNamespace } from "../../../../sdk/packages/qbrain-governance/dist/storage-policy.js"
import {
	discoverSkills,
	getSkillContent,
	setSkillDisabledInFrontmatter,
} from "../core/context/instructions/user-instructions/skills"

const home = fs.mkdtempSync(path.join(os.tmpdir(), "qb-skill-consumer-"))
const upstream = path.join(home, ".cline")
const root = path.join(home, ".cline-qb")
const project = path.join(home, "project")
const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(home)
setHomeDir(home)
registerStorageNamespace(createQbrainStorageNamespace({ homeDir: home, env: {} }))
beforeEach(() => {
	fs.rmSync(home, { recursive: true, force: true })
	fs.mkdirSync(project, { recursive: true })
})
afterAll(() => {
	homedirSpy.mockRestore()
	fs.rmSync(home, { recursive: true, force: true })
})
function skill(dir: string, name = "example") {
	fs.mkdirSync(dir, { recursive: true })
	const file = path.join(dir, "SKILL.md")
	fs.writeFileSync(file, "---\nname: " + name + "\ndescription: fixture\n---\nPrivate instructions\n")
	return file
}
function metadata(file: string) {
	return [{ name: "example", description: "fixture", path: file, source: "global" as const }]
}

describe("AC-QB-053 skill file consumers", () => {
	it("discovers private and project skills without importing upstream skills", async () => {
		skill(path.join(root, "skills", "example"))
		skill(path.join(project, ".cline", "skills", "local"), "local")
		skill(path.join(upstream, "skills", "excluded"), "excluded")
		expect((await discoverSkills(project)).map((s) => s.name).sort()).toEqual(["example", "local"])
	})
	it("rejects nested directory aliases before scanning upstream skill metadata", async () => {
		const source = path.join(upstream, "example")
		skill(source)
		fs.mkdirSync(path.join(root, "skills"), { recursive: true })
		fs.symlinkSync(source, path.join(root, "skills", "example"), "junction")
		await expect(discoverSkills(project)).rejects.toThrow(/upstream Cline/)
	})
	it("rejects a manifest symlink before metadata reads", async () => {
		const target = skill(path.join(upstream, "example"))
		const dir = path.join(root, "skills", "example")
		fs.mkdirSync(dir, { recursive: true })
		fs.symlinkSync(target, path.join(dir, "SKILL.md"))
		await expect(discoverSkills(project)).rejects.toThrow(/upstream Cline/)
	})
	it("full skill reads reject a path replaced after discovery", async () => {
		const file = skill(path.join(root, "skills", "example"))
		const discovered = await discoverSkills(project)
		const excluded = skill(path.join(upstream, "example"))
		fs.unlinkSync(file)
		fs.symlinkSync(excluded, file)
		await expect(getSkillContent("example", discovered)).rejects.toThrow(/upstream Cline/)
	})
	it("explicit skill reads cannot target upstream state", async () => {
		const file = skill(path.join(upstream, "example"))
		await expect(getSkillContent("example", metadata(file))).rejects.toThrow(/upstream Cline/)
	})
	it("enablement writes reject excluded aliases and preserve their content", async () => {
		const excluded = skill(path.join(upstream, "example"))
		const file = path.join(root, "skills", "example", "SKILL.md")
		fs.mkdirSync(path.dirname(file), { recursive: true })
		fs.symlinkSync(excluded, file)
		const before = fs.readFileSync(excluded, "utf8")
		await expect(setSkillDisabledInFrontmatter(file, false)).rejects.toThrow(/upstream Cline/)
		expect(fs.readFileSync(excluded, "utf8")).toBe(before)
	})
	it("allowed skills can be read and toggled without changing their instructions", async () => {
		const file = skill(path.join(root, "skills", "example"))
		expect((await getSkillContent("example", metadata(file)))?.instructions).toBe("Private instructions")
		expect(await setSkillDisabledInFrontmatter(file, false)).toBe(true)
		expect(fs.readFileSync(file, "utf8")).toContain("disabled: true")
		expect(await setSkillDisabledInFrontmatter(file, true)).toBe(true)
		expect(fs.readFileSync(file, "utf8")).not.toContain("disabled:")
		expect((await getSkillContent("example", metadata(file)))?.instructions).toBe("Private instructions")
	})
	it("governed reads report a missing previously discovered file", async () => {
		await expect(getSkillContent("example", metadata(path.join(root, "missing", "SKILL.md")))).rejects.toThrow()
	})
})

describe("AC-QB-053 skill toggle publication", () => {
	function controller(onWrite = () => {}) {
		return {
			stateManager: {
				getGlobalSettingsKey: () => ({}),
				getWorkspaceStateKey: () => ({}),
				getGlobalStateKey: () => ({}),
				setGlobalState: vi.fn(onWrite),
				setWorkspaceState: vi.fn(onWrite),
			},
			postStateToWebview: vi.fn(async () => {}),
		}
	}
	for (const isGlobal of [true, false]) {
		for (const failure of ["unsafe", "missing"]) {
			it((isGlobal ? "global" : "local") + " toggle preserves state after " + failure + " file refusal", async () => {
				const file = failure === "unsafe" ? skill(path.join(upstream, "example")) : path.join(root, "missing", "SKILL.md")
				const target = controller()
				await expect(
					toggleSkill(target as any, { metadata: undefined, skillPath: file, isGlobal, enabled: false }),
				).rejects.toThrow()
				expect(target.stateManager.setGlobalState).not.toHaveBeenCalled()
				expect(target.stateManager.setWorkspaceState).not.toHaveBeenCalled()
				expect(target.postStateToWebview).not.toHaveBeenCalled()
				if (failure === "unsafe") expect(fs.readFileSync(file, "utf8")).not.toContain("disabled:")
			})
		}
		it((isGlobal ? "global" : "local") + " toggle publishes only after frontmatter is written", async () => {
			const file = skill(path.join(root, "skills", "example"))
			const target = controller(() => expect(fs.readFileSync(file, "utf8")).toContain("disabled: true"))
			const result = await toggleSkill(target as any, { metadata: undefined, skillPath: file, isGlobal, enabled: false })
			expect(isGlobal ? result.globalSkillsToggles[file] : result.localSkillsToggles[file]).toBe(false)
			expect(target.postStateToWebview).toHaveBeenCalledTimes(1)
		})
	}
	it("remote toggle retains its separate store without file access", async () => {
		const target = controller()
		const result = await toggleSkill(target as any, {
			metadata: undefined,
			skillPath: "remote:example",
			isGlobal: true,
			enabled: false,
		})
		expect(result.remoteSkillsToggles.example).toBe(false)
		expect(target.stateManager.setGlobalState).toHaveBeenCalledWith("remoteSkillsToggles", { example: false })
		expect(target.postStateToWebview).toHaveBeenCalledTimes(1)
	})
})

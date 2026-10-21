// SPDX-License-Identifier: Apache-2.0
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerStorageNamespace } from "@cline/shared/storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UnifiedConfigFileWatcher } from "./unified-config-file-watcher";

import {
	createRulesConfigDefinition,
	createSkillsConfigDefinition,
	createWorkflowsConfigDefinition,
} from "./user-instruction-config-loader";

const denied = new Set<string>();
registerStorageNamespace({
	validatePath(path) {
		if (denied.has(path)) throw new Error("Excluded upstream storage");
		return path;
	},
	resolvePath: () => "/unused",
	globalRulesPaths: () => [],
});
const roots: string[] = [];
afterEach(async () => {
	denied.clear();
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});
async function setup() {
	const root = await mkdtemp(join(tmpdir(), "qb-watcher-storage-"));
	roots.push(root);
	const file = join(root, "rule.md");
	await writeFile(file, "private fixture");
	const parseFile = vi.fn(({ content }: { content: string }) => content);
	const discoverFiles = vi.fn(async () => [
		{ directoryPath: root, filePath: file, fileName: "rule.md" },
	]);
	const definition = {
		type: "rule",
		directories: [root],
		discoverFiles,
		parseFile,
		resolveId: () => "rule",
	};
	return { root, file, parseFile, discoverFiles, definition };
}
describe("TEST-QB-053: configuration read boundaries", () => {
	it.each([
		createRulesConfigDefinition,
		createSkillsConfigDefinition,
		createWorkflowsConfigDefinition,
	])("guards direct instruction discovery", async (create) => {
		const f = await setup();
		const definition = create({ directories: [f.root] });
		denied.add(f.root);
		await expect(definition.discoverFiles!(f.root)).rejects.toThrow(
			"Excluded upstream storage",
		);
	});
	it("guards managed plugin manifest reads beneath an allowed root", async () => {
		const f = await setup();
		const managed = join(f.root, ".cline");
		const plugin = join(managed, "managed-plugin");
		await mkdir(plugin, { recursive: true });
		const manifest = join(plugin, "managed.json");
		await writeFile(manifest, "{}");
		denied.add(manifest);
		const definition = createRulesConfigDefinition({ directories: [managed] });
		await expect(definition.discoverFiles!(managed)).rejects.toThrow(
			"Excluded upstream storage",
		);
	});
	it("can restart after blocked startup without leaving live watchers", async () => {
		const f = await setup();
		denied.add(f.root);
		const watcher = new UnifiedConfigFileWatcher([f.definition]);
		try {
			await expect(watcher.start()).rejects.toThrow(
				"Excluded upstream storage",
			);
			denied.clear();
			await watcher.start();
			expect(f.parseFile).toHaveBeenCalledTimes(1);
		} finally {
			watcher.stop();
		}
	});
	it("reports a delayed watcher refusal without an unhandled rejection", async () => {
		const f = await setup();
		const watcher = new UnifiedConfigFileWatcher([f.definition], {
			debounceMs: 1,
		});
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await watcher.start();
			const reported = new Promise<unknown>((resolve, reject) => {
				timer = setTimeout(
					() => reject(new Error("No policy error event")),
					3000,
				);
				watcher.subscribe((event) => {
					if (event.kind === "error") resolve(event.error);
				});
			});
			denied.add(f.root);
			await writeFile(f.file, "changed fixture");
			await expect(reported).resolves.toMatchObject({
				message: "Excluded upstream storage",
			});
			expect(f.parseFile).toHaveBeenCalledTimes(1);
		} finally {
			clearTimeout(timer);
			watcher.stop();
		}
	});
	it("rejects excluded roots before invoking custom discovery", async () => {
		const f = await setup();
		denied.add(f.root);
		const watcher = new UnifiedConfigFileWatcher([f.definition]);
		await expect(watcher.refreshAll()).rejects.toThrow(
			"Excluded upstream storage",
		);
		expect(f.discoverFiles).not.toHaveBeenCalled();
		expect(f.parseFile).not.toHaveBeenCalled();
	});
	it("rejects excluded file candidates even when parse diagnostics are disabled", async () => {
		const f = await setup();
		denied.add(f.file);
		const watcher = new UnifiedConfigFileWatcher([f.definition], {
			emitParseErrors: false,
		});
		await expect(watcher.refreshAll()).rejects.toThrow(
			"Excluded upstream storage",
		);
		expect(f.parseFile).not.toHaveBeenCalled();
		expect(watcher.getSnapshot("rule").size).toBe(0);
	});
	it("rechecks after optional include callbacks before reading a file", async () => {
		const f = await setup();
		const watcher = new UnifiedConfigFileWatcher([
			{
				...f.definition,
				includeFile: () => {
					denied.add(f.file);
					return true;
				},
			},
		]);
		await expect(watcher.refreshAll()).rejects.toThrow(
			"Excluded upstream storage",
		);
		expect(f.parseFile).not.toHaveBeenCalled();
	});
	it("rechecks a changed root on each refresh", async () => {
		const f = await setup();
		const watcher = new UnifiedConfigFileWatcher([f.definition]);
		await watcher.refreshAll();
		expect(f.parseFile).toHaveBeenCalledTimes(1);
		denied.add(f.root);
		await expect(watcher.refreshAll()).rejects.toThrow(
			"Excluded upstream storage",
		);
		expect(f.discoverFiles).toHaveBeenCalledTimes(1);
		expect(f.parseFile).toHaveBeenCalledTimes(1);
	});
	it("rejects an excluded discovered watch directory", async () => {
		const f = await setup();
		const other = join(f.root, "other");
		await mkdir(other);
		denied.add(other);
		f.discoverFiles.mockResolvedValue([
			{ directoryPath: other, filePath: f.file, fileName: "rule.md" },
		]);
		const watcher = new UnifiedConfigFileWatcher([f.definition]);
		await expect(watcher.refreshAll()).rejects.toThrow(
			"Excluded upstream storage",
		);
		expect(f.parseFile).not.toHaveBeenCalled();
	});
});

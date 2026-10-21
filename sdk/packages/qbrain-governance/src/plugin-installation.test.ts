// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import {
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { Header } from "tar";
import { afterEach, describe, expect, it, vi } from "vitest";
import { preparePluginInstallation } from "./plugin-installation";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, writeFileSync: vi.fn(actual.writeFileSync) };
});

type FixtureEntry = {
	path: string;
	content?: string;
	type?: "File" | "Directory" | "SymbolicLink" | "Link" | "FIFO";
	linkpath?: string;
	size?: number;
};
const manifest = {
	name: "@sharpninja/mcpserver-cline-v2-plugin",
	version: "1.118.0",
	type: "module",
	main: "dist/index.js",
	exports: { ".": { import: "./dist/index.js" } },
};
const base: FixtureEntry[] = [
	{ path: "package/package.json", content: JSON.stringify(manifest) },
	{
		path: "package/dist/index.js",
		content: 'throw new Error("Must not execute during installation");',
	},
	{ path: "package/skills/test/SKILL.md", content: "# Test skill" },
	{ path: "package/lib/tool.ps1", content: "Write-Output example" },
	{ path: "package/memory-descriptor.json", content: "{}" },
];
function archive(entries: FixtureEntry[] = base): Buffer {
	return Buffer.concat([
		...entries.flatMap((entry) => {
			const content = Buffer.from(entry.content ?? "");
			const header = new Header({
				path: entry.path,
				type: entry.type ?? "File",
				size: entry.size ?? content.length,
				linkpath: entry.linkpath,
				mode: 0o777,
			});
			const block = Buffer.alloc(512);
			header.encode(block);
			return [
				block,
				content,
				Buffer.alloc((512 - (content.length % 512)) % 512),
			];
		}),
		Buffer.alloc(1024),
	]);
}
function options(bytes = archive()) {
	return {
		bytes,
		binding: {
			pluginName: manifest.name,
			pluginVersion: manifest.version,
			artifactSha256: createHash("sha256").update(bytes).digest("hex"),
		},
		requiredFiles: [
			"skills/test/SKILL.md",
			"lib/tool.ps1",
			"memory-descriptor.json",
		],
	};
}
const parents: string[] = [];
function parent() {
	const path = mkdtempSync(join(tmpdir(), "qb-plugin-test-"));
	parents.push(path);
	return path;
}
afterEach(() => {
	for (const path of parents.splice(0))
		rmSync(path, { recursive: true, force: true });
});

describe("signed archive installation", () => {
	it("bounds decompression even when content is only metadata or padding", async () => {
		// A highly compressible archive bomb must fail before tar parsing or disk writes.
		const bomb = gzipSync(Buffer.alloc(256 * 1024 * 1024 + 1));
		await expect(preparePluginInstallation(options(bomb))).rejects.toThrow();
	}, 15000);
	it("refuses nested compressed streams and corrupt gzip trailers", async () => {
		await expect(
			preparePluginInstallation(options(gzipSync(gzipSync(archive())))),
		).rejects.toThrow();
		const broken = gzipSync(archive());
		broken[broken.length - 8] ^= 1;
		await expect(preparePluginInstallation(options(broken))).rejects.toThrow();
	});
	it("cleans its own directory after a filesystem write failure", async () => {
		const prepared = await preparePluginInstallation(options());
		const directory = parent();
		const write = vi.mocked(writeFileSync).mockImplementationOnce(() => {
			throw new Error("disk full");
		});
		try {
			expect(() => prepared.install(directory)).toThrow();
		} finally {
			write.mockRestore();
		}
		expect(readdirSync(directory)).toEqual([]);
	});
	it("reconstructs expected inventory from pinned bytes after restart", async () => {
		const first = await preparePluginInstallation(options());
		const installed = first.install(parent());
		const restarted = await preparePluginInstallation(options());
		expect(restarted.verify(installed.root)).toEqual(installed);
		writeFileSync(join(installed.root, "memory-descriptor.json"), "[]");
		expect(() => restarted.verify(installed.root)).toThrow();
	});
	it.each([
		false,
		true,
	])("installs all assets without executing plugin (gzip=%s)", async (gzip) => {
		const prepared = await preparePluginInstallation(
			options(gzip ? gzipSync(archive()) : archive()),
		);
		const installed = prepared.install(parent());
		expect(prepared.fileCount).toBe(5);
		expect(readFileSync(installed.entrypoint, "utf8")).toBe(base[1].content);
		expect(readFileSync(join(installed.root, "lib/tool.ps1"), "utf8")).toBe(
			base[3].content,
		);
		expect(prepared.verify(installed.root)).toEqual(installed);
		expect(Object.isFrozen(prepared)).toBe(true);
		expect(Object.isFrozen(installed.binding)).toBe(true);
	});
	it("captures bytes, binding and asset list before asynchronous parsing", async () => {
		const input = options(gzipSync(archive()));
		const pending = preparePluginInstallation(input);
		input.bytes.fill(0);
		input.binding.pluginVersion = "bad";
		input.requiredFiles.push("absent");
		const prepared = await pending;
		expect(prepared.install(parent()).binding.pluginVersion).toBe(
			manifest.version,
		);
	});
	it("rejects modified bytes despite caller presenting a binding", async () => {
		const input = options();
		input.bytes[600] ^= 1;
		await expect(preparePluginInstallation(input)).rejects.toThrow(
			"Required plugin installation",
		);
	});
	it.each([
		"pluginName",
		"pluginVersion",
		"artifactSha256",
	] as const)("rejects wrong %s", async (field) => {
		const input = options();
		input.binding[field] = "wrong";
		await expect(preparePluginInstallation(input)).rejects.toThrow();
	});
	it.each([
		"package/../escape",
		"/package/absolute",
		"C:/package/drive",
		"package/a\\b",
		"package/./dot",
		"package//empty",
		"package/CON.txt",
		"package/end.",
		"package/end ",
		"package/unicodé",
		"elsewhere/file",
	])("refuses unsafe path %s before writes", async (path) => {
		const directory = parent();
		await expect(
			preparePluginInstallation(
				options(archive([...base, { path, content: "bad" }])),
			),
		).rejects.toThrow();
		expect(readdirSync(directory)).toEqual([]);
	});
	it.each([
		"SymbolicLink",
		"Link",
		"FIFO",
	] as const)("rejects %s", async (type) => {
		await expect(
			preparePluginInstallation(
				options(
					archive([
						...base,
						{
							path: "package/evil",
							type,
							linkpath: type === "FIFO" ? undefined : "dist/index.js",
						},
					]),
				),
			),
		).rejects.toThrow();
	});
	it.each([
		{ path: "package/dist/index.js", content: "duplicate" },
		{ path: "package/DIST/extra.js", content: "case alias" },
		{ path: "package/dist", content: "file ancestor" },
	])("rejects duplicate or conflicting inventory $path", async (entry) => {
		await expect(
			preparePluginInstallation(options(archive([...base, entry]))),
		).rejects.toThrow();
	});
	it("accepts explicit directories, including empty ones", async () => {
		const prepared = await preparePluginInstallation(
			options(
				archive([
					{ path: "package/", type: "Directory" },
					{ path: "package/dist/", type: "Directory" },
					{ path: "package/empty/", type: "Directory" },
					...base,
				]),
			),
		);
		const installed = prepared.install(parent());
		rmSync(join(installed.root, "empty"), { recursive: true });
		expect(() => prepared.verify(installed.root)).toThrow();
	});
	it.each([
		"package/package.json",
		"package/dist/index.js",
		"package/lib/tool.ps1",
	])("rejects missing required asset %s", async (path) => {
		await expect(
			preparePluginInstallation(
				options(archive(base.filter((entry) => entry.path !== path))),
			),
		).rejects.toThrow();
	});
	it("rejects package entrypoint redirect", async () => {
		const entries = [...base];
		entries[0] = {
			...base[0],
			content: JSON.stringify({ ...manifest, main: "other.js" }),
		};
		await expect(
			preparePluginInstallation(options(archive(entries))),
		).rejects.toThrow();
	});
	it("rejects truncated payload and malformed tar", async () => {
		await expect(
			preparePluginInstallation(options(archive().subarray(0, 600))),
		).rejects.toThrow();
		await expect(
			preparePluginInstallation(options(Buffer.from("not tar"))),
		).rejects.toThrow();
	});
	it("rejects oversized entry before allocating its declared body", async () => {
		await expect(
			preparePluginInstallation(
				options(
					archive([{ path: "package/huge", size: 32 * 1024 * 1024 + 1 }]),
				),
			),
		).rejects.toThrow();
	});
	it("bounds entry count", async () => {
		await expect(
			preparePluginInstallation(
				options(
					archive([
						...base,
						...Array.from({ length: 4096 }, (_, index) => ({
							path: `package/file${index}`,
						})),
					]),
				),
			),
		).rejects.toThrow();
	});
	it.each([
		"changed",
		"missing",
		"extra",
		"symlink",
		"hardlink",
	])("detects installed tree %s", async (mode) => {
		const prepared = await preparePluginInstallation(options());
		const directory = parent();
		const installed = prepared.install(directory);
		if (mode === "changed")
			writeFileSync(installed.entrypoint, "X".repeat(base[1].content!.length));
		if (mode === "missing") rmSync(installed.entrypoint);
		if (mode === "extra")
			writeFileSync(join(installed.root, "unapproved.js"), "extra");
		if (mode === "hardlink")
			linkSync(installed.entrypoint, join(directory, "outside.js"));
		if (mode === "symlink") {
			const outside = join(directory, "outside.js");
			writeFileSync(outside, base[1].content!);
			rmSync(installed.entrypoint);
			symlinkSync(outside, installed.entrypoint);
		}
		expect(() => prepared.verify(installed.root)).toThrow(
			"Required plugin installation",
		);
	});
	it("rejects directory symlinks both as install parents and installed children", async () => {
		const prepared = await preparePluginInstallation(options());
		const directory = parent();
		const linked = join(directory, "linked");
		symlinkSync(directory, linked, "dir");
		expect(() => prepared.install(linked)).toThrow();
		const installed = prepared.install(directory);
		rmSync(join(installed.root, "dist"), { recursive: true });
		symlinkSync(directory, join(installed.root, "dist"), "dir");
		expect(() => prepared.verify(installed.root)).toThrow();
	});
	it("keeps simultaneous installations distinct and never reuses interrupted directories", async () => {
		const prepared = await preparePluginInstallation(options());
		const directory = parent();
		const orphan = join(directory, "plugin-incomplete");
		mkdirSync(orphan);
		writeFileSync(join(orphan, "partial"), "keep");
		const installed = await Promise.all(
			[0, 1].map(async () => prepared.install(directory)),
		);
		expect(installed[0].root).not.toBe(installed[1].root);
		expect(existsSync(join(orphan, "partial"))).toBe(true);
		for (const item of installed)
			expect(prepared.verify(item.root)).toEqual(item);
		expect(() => prepared.verify(orphan)).toThrow();
	});
	it("sanitizes malformed manifests and path failures", async () => {
		const entries = [...base];
		entries[0] = { ...base[0], content: "private secret invalid JSON" };
		await expect(
			preparePluginInstallation(options(archive(entries))),
		).rejects.toThrow(
			/^Required plugin installation is invalid or unavailable\.$/,
		);
		const prepared = await preparePluginInstallation(options());
		expect(() => prepared.install("private-secret-relative")).toThrow(
			/^Required plugin installation is invalid or unavailable\.$/,
		);
	});
});

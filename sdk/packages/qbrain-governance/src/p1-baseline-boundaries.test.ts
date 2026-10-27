// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Header, Parser } from "tar";
import { describe, expect, it } from "vitest";

// TEST-QB-003/011/055, AC-QB-003/011 and O's retained baseline increment.
// Test composition only. No production import, test-selection flag or new wire API.
const sha = (bytes: string | Buffer) =>
	createHash("sha256").update(bytes).digest("hex");
const newlinePaths = ["line\nbreak.ts", "space name.ts"];
const objectId = "1".repeat(40);
type Entry = {
	path: string;
	bytes: Buffer;
	type?:
		| "File"
		| "ExtendedHeader"
		| "GlobalExtendedHeader"
		| "NextFileHasLongPath";
};
function archive(entries: Entry[]): Buffer {
	return Buffer.concat([
		...entries.flatMap(({ path, bytes, type = "File" }) => {
			const block = Buffer.alloc(512);
			new Header({ path, type, size: bytes.length, mode: 0o644 }).encode(block);
			return [block, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512)];
		}),
		Buffer.alloc(1024),
	]);
}
function pax(path: string): Buffer {
	const body = `path=${path}\n`;
	let length = Buffer.byteLength(body) + 2;
	while (Buffer.byteLength(`${length} ${body}`) !== length)
		length = Buffer.byteLength(`${length} ${body}`);
	return Buffer.from(`${length} ${body}`);
}
const base: Entry[] = [
	{
		path: "package/package.json",
		bytes: Buffer.from('{"name":"fixture","version":"1"}'),
	},
	{ path: "package/dist/index.js", bytes: Buffer.from("export {};") },
];
const archiveVectors = [
	{
		label: "proper slash path",
		entries: [...base, { path: "package/a/b", bytes: Buffer.from("fixture") }],
		accepted: true,
	},
	...[
		"package/a\\b",
		"package/../outside",
		"/absolute",
		"package/NUL.txt",
		"package/a:stream",
		"package/trailing.",
	].map((path) => ({
		label: path,
		entries: [...base, { path, bytes: Buffer.from("fixture") }],
		accepted: false,
	})),
	...(
		["ExtendedHeader", "GlobalExtendedHeader", "NextFileHasLongPath"] as const
	).map((type) => ({
		label: `${type} backslash`,
		accepted: false,
		entries: [
			...base,
			{
				path: "metadata",
				type,
				bytes:
					type === "NextFileHasLongPath"
						? Buffer.from("package/a\\b\0")
						: pax("package/a\\b"),
			},
			{ path: "package/safe", bytes: Buffer.from("fixture") },
		],
	})),
];
type Call = {
	operation: string;
	path?: string;
	mode?: number;
	bytesHash?: string;
};
type FileState = { mode: number; bytes: Buffer };
type Fault =
	| "none"
	| "drop-raw-backslash"
	| "omit-write"
	| "reverse-writes"
	| "erase-mode"
	| "split-newline"
	| "omit-stat"
	| "wrong-object";

// The dependency owns inputs and records requests/effects. It never sees expectations.
class BoundaryDependencies {
	readonly calls: Call[] = [];
	readonly writes = new Map<string, Buffer>();
	readonly files = new Map<string, FileState>();
	index = "";
	constructor(readonly fault: Fault = "none") {}
	parse(bytes: Buffer): { raw: string; effective: string; bytes: Buffer }[] {
		this.calls.push({ operation: "archive.parse", bytesHash: sha(bytes) });
		const result: { raw: string; effective: string; bytes: Buffer }[] = [];
		let pending: string | undefined;
		for (let offset = 0; offset + 512 <= bytes.length; ) {
			const block = bytes.subarray(offset, offset + 512);
			if (block.every((byte) => byte === 0)) break;
			const raw = block.subarray(0, 100).toString("utf8").split("\0")[0];
			const size = Number.parseInt(
				block.subarray(124, 136).toString("ascii"),
				8,
			);
			assert.ok(
				Number.isSafeInteger(size) && size >= 0,
				"scripted header size",
			);
			const content = bytes.subarray(offset + 512, offset + 512 + size);
			const type = String.fromCharCode(block[156]);
			if (type === "x" || type === "g") {
				const record = content.toString("utf8");
				pending = record.slice(record.indexOf("path=") + 5, -1);
			} else if (type === "L")
				pending = content.toString("utf8").split("\0")[0];
			else {
				let original = pending ?? raw;
				pending = undefined;
				if (this.fault === "drop-raw-backslash")
					original = original.replaceAll("\\", "/");
				result.push({
					raw: original,
					effective: original.replaceAll("\\", "/"),
					bytes: Buffer.from(content),
				});
			}
			offset += 512 + Math.ceil(size / 512) * 512;
		}
		return this.fault === "reverse-writes" ? result.reverse() : result;
	}
	write(path: string, bytes: Buffer): void {
		if (this.fault === "omit-write") return;
		this.calls.push({
			operation: "filesystem.write",
			path,
			bytesHash: sha(bytes),
		});
		this.writes.set(path, Buffer.from(bytes));
	}
	stat(path: string): number {
		this.calls.push({ operation: "filesystem.stat", path });
		if (this.fault === "omit-stat") throw new Error("stat callback omitted");
		const file = this.files.get(path);
		assert.ok(file, "missing fixture file");
		return this.fault === "erase-mode" ? 0o644 : file.mode;
	}
	read(path: string): Buffer {
		this.calls.push({ operation: "filesystem.read", path });
		return Buffer.from(this.files.get(path)!.bytes);
	}
	git(): string {
		this.calls.push({ operation: "git.ls-files-stage-z" });
		if (this.fault === "split-newline")
			return this.index.replaceAll("\n", "\0");
		if (this.fault === "wrong-object")
			return this.index.replaceAll(objectId, "2".repeat(40));
		return this.index;
	}
}

// Independent small test model: validates bytes/paths before writes and derives
// fingerprint observations from stat/read/git dependencies. This is not product code.
class BaselineBoundaryModel {
	constructor(readonly dependencies: BoundaryDependencies) {}
	async install(bytes: Buffer): Promise<void> {
		const entries = this.dependencies.parse(bytes);
		for (const entry of entries) {
			const parts = entry.raw.split("/");
			assert.ok(
				entry.raw.startsWith("package/") && !/[\\:<>"|?*]/.test(entry.raw),
			);
			assert.ok(
				parts.every(
					(part) =>
						part &&
						part !== "." &&
						part !== ".." &&
						!/[. ]$/.test(part) &&
						!/^(con|prn|aux|nul)(\.|$)/i.test(part),
				),
			);
			assert.equal(entry.effective, entry.raw);
		}

		for (const entry of entries)
			this.dependencies.write(entry.raw.slice(8), entry.bytes);
	}
	async capture(): Promise<{
		hash: string;
		files: {
			path: string;
			staged: { mode: string; objectId: string; stage: number }[];
		}[];
	}> {
		const staged = new Map<
			string,
			{ mode: string; objectId: string; stage: number }[]
		>();
		for (const record of this.dependencies.git().split("\0").filter(Boolean)) {
			const tab = record.indexOf("\t");
			assert.ok(tab > 0);
			const [mode, id, stage] = record.slice(0, tab).split(" ");
			const path = record.slice(tab + 1);
			assert.match(mode, /^\d{6}$/);
			assert.match(id, /^[a-f0-9]{40}$/);
			assert.match(stage, /^[0-3]$/);
			staged.set(path, [
				...(staged.get(path) ?? []),
				{ mode, objectId: id, stage: Number(stage) },
			]);
		}
		const paths = [
			...new Set([...this.dependencies.files.keys(), ...staged.keys()]),
		].sort();
		const material = paths.map((path) => [
			path,
			this.dependencies.files.has(path)
				? this.dependencies.stat(path) & 0o111
				: null,
			this.dependencies.files.has(path)
				? sha(this.dependencies.read(path))
				: null,
			staged.get(path) ?? [],
		]);
		return {
			hash: sha(JSON.stringify(material)),
			files: paths.map((path) => ({ path, staged: staged.get(path) ?? [] })),
		};
	}
}

// SAME runner/assertions accept a future production adapter, with actual captured
// writes/stat/git effects. No adapter may synthesize observations from expectations.
export async function assertArchiveBoundary(
	install: (bytes: Buffer) => Promise<void>,
	dependencies: Pick<BoundaryDependencies, "calls" | "writes">,
	vector: (typeof archiveVectors)[number],
): Promise<void> {
	const bytes = archive(vector.entries);
	const before = Buffer.from(bytes);
	if (!vector.accepted) {
		await expect(install(bytes)).rejects.toThrow();
		expect([...dependencies.writes]).toEqual([]);
		expect(
			dependencies.calls.filter(
				(call) => call.operation === "filesystem.write",
			),
		).toEqual([]);
	} else {
		await install(bytes);
		expect([...dependencies.writes.keys()]).toEqual([
			"package.json",
			"dist/index.js",
			"a/b",
		]);
		expect(dependencies.calls.map((call) => call.operation)).toEqual([
			"archive.parse",
			"filesystem.write",
			"filesystem.write",
			"filesystem.write",
		]);
		for (const entry of vector.entries)
			expect(dependencies.writes.get(entry.path.slice(8))).toEqual(entry.bytes);
	}
	expect(bytes).toEqual(before);
	console.log(
		"BASELINE_ARCHIVE_INTERACTION",
		JSON.stringify({
			label: vector.label,
			calls: dependencies.calls,
			writes: [...dependencies.writes].map(([path, bytes]) => ({
				path,
				bytesHash: sha(bytes),
			})),
		}),
	);
}
export async function assertExecutableBoundary(
	capture: BaselineBoundaryModel["capture"],
	mutate: () => void,
): Promise<void> {
	const first = await capture();
	mutate();
	// Same production assertion as workspace-fingerprint.test.ts:90.
	expect((await capture()).hash).not.toBe(first.hash);
}
export async function assertPathBoundary(
	capture: BaselineBoundaryModel["capture"],
): Promise<void> {
	const state = await capture();
	// Original exact newline input and BOTH assertions retained.
	expect(state.files.map((file) => file.path)).toEqual([
		"line\nbreak.ts",
		"space name.ts",
	]);
	expect(state.files.every((file) => file.staged.length === 1)).toBe(true);
	for (const file of state.files)
		expect(file.staged[0]).toEqual({ mode: "100644", objectId, stage: 0 });
}
function pathDependencies(fault: Fault): BoundaryDependencies {
	const dependencies = new BoundaryDependencies(fault);
	for (const [index, path] of newlinePaths.entries())
		dependencies.files.set(path, {
			mode: 0o644,
			bytes: Buffer.from(index ? "one" : "two"),
		});
	dependencies.index = newlinePaths
		.map((path) => `100644 ${objectId} 0\t${path}\0`)
		.join("");
	return dependencies;
}

describe("P1 retained baseline: independent mocked boundaries", () => {
	for (const vector of archiveVectors) {
		it(`TEST-QB-003 raw archive: ${vector.label}`, async () => {
			const dependencies = new BoundaryDependencies();
			const model = new BaselineBoundaryModel(dependencies);
			await assertArchiveBoundary(
				(bytes) => model.install(bytes),
				dependencies,
				vector,
			);
			expect(dependencies.calls[0].operation).toBe("archive.parse");
		});
	}
	for (const fault of ["omit-write", "reverse-writes"] as const) {
		it(`rejects archive dependency effect ${fault} through same assertions`, async () => {
			const dependencies = new BoundaryDependencies(fault);
			const model = new BaselineBoundaryModel(dependencies);
			await expect(
				assertArchiveBoundary(
					(bytes) => model.install(bytes),
					dependencies,
					archiveVectors[0],
				),
			).rejects.toThrow();
		});
	}
	for (const vector of archiveVectors.filter(
		(vector) =>
			vector.label.includes("backslash") || vector.label === "package/a\\b",
	)) {
		it(`rejects lost raw path evidence: ${vector.label}`, async () => {
			const dependencies = new BoundaryDependencies("drop-raw-backslash");
			const model = new BaselineBoundaryModel(dependencies);
			await expect(
				assertArchiveBoundary(
					(bytes) => model.install(bytes),
					dependencies,
					vector,
				),
			).rejects.toThrow();
		});
	}
	it("TEST-QB-011 mocked stat executable bit changes invalidate identical bytes", async () => {
		const dependencies = new BoundaryDependencies();
		dependencies.files.set("run.sh", {
			mode: 0o644,
			bytes: Buffer.from("echo fixture"),
		});
		const model = new BaselineBoundaryModel(dependencies);
		await assertExecutableBoundary(
			() => model.capture(),
			() => {
				dependencies.files.get("run.sh")!.mode = 0o755;
			},
		);
		expect(dependencies.calls.map((call) => call.operation)).toEqual([
			"git.ls-files-stage-z",
			"filesystem.stat",
			"filesystem.read",
			"git.ls-files-stage-z",
			"filesystem.stat",
			"filesystem.read",
		]);
	});
	it("rejects a stat provider that loses executable mode through same assertion", async () => {
		const dependencies = new BoundaryDependencies("erase-mode");
		dependencies.files.set("run.sh", {
			mode: 0o644,
			bytes: Buffer.from("echo fixture"),
		});
		const model = new BaselineBoundaryModel(dependencies);
		await expect(
			assertExecutableBoundary(
				() => model.capture(),
				() => {
					dependencies.files.get("run.sh")!.mode = 0o755;
				},
			),
		).rejects.toThrow();
	});
	it("TEST-QB-011 faithful filesystem/git fixture retains newline and space boundaries", async () => {
		const dependencies = pathDependencies("none");
		const model = new BaselineBoundaryModel(dependencies);
		await assertPathBoundary(() => model.capture());
		expect(
			dependencies.calls
				.filter((call) => call.operation === "filesystem.read")
				.map((call) => call.path),
		).toEqual(newlinePaths);
	});
	for (const fault of ["split-newline", "omit-stat", "wrong-object"] as const) {
		it(`rejects ${fault} dependency response through same path assertions`, async () => {
			const model = new BaselineBoundaryModel(pathDependencies(fault));
			await expect(assertPathBoundary(() => model.capture())).rejects.toThrow();
		});
	}
});

// Evidence probes use native Node's fs and the installed tar parser, not the model.
// They disclose platform limits; they do not turn baseline production failures green.
describe("P1 raw archive and native filesystem evidence", () => {
	it("preserves raw backslash header bytes while tar exposes a normalized Windows entry", async () => {
		const bytes = archive([
			{ path: "package/a\\b", bytes: Buffer.from("fixture") },
		]);
		const raw = bytes.subarray(0, 100).toString("ascii").split("\0")[0];
		expect(raw).toBe("package/a\\b");
		expect(bytes.subarray(0, raw.length).includes(0x5c)).toBe(true);
		const entries: { path: string; headerPath: string; bytes: string }[] = [];
		await new Promise<void>((accept, reject) => {
			const parser = new Parser({ strict: true });
			parser.on("error", reject);
			parser.on("end", accept);
			parser.on("entry", (entry) => {
				const chunks: Buffer[] = [];
				entry.on("data", (chunk: Buffer) => chunks.push(chunk));
				entry.on("end", () =>
					entries.push({
						path: entry.path,
						headerPath: entry.header.path!,
						bytes: Buffer.concat(chunks).toString(),
					}),
				);
				entry.resume();
			});
			parser.end(bytes);
		});
		expect(entries).toEqual([
			{
				path: process.platform === "win32" ? "package/a/b" : raw,
				headerPath: raw,
				bytes: "fixture",
			},
		]);
		console.log("RAW_TAR_EVIDENCE", {
			platform: process.platform,
			node: process.version,
			headerHex: bytes.subarray(0, 100).toString("hex"),
			archiveSha256: sha(bytes),
			archiveBase64: bytes.toString("base64"),
			entries,
		});
	});
	it("records chmod/stat and supported staged executable-bit mutation on native host", async () => {
		const root = await fs.mkdtemp(join(tmpdir(), "qb-baseline-mode-"));
		try {
			const path = join(root, "run.sh");
			await fs.writeFile(path, "echo fixture");
			await fs.chmod(path, 0o644);
			const before = await fs.stat(path);
			await fs.chmod(path, 0o755);
			const after = await fs.stat(path);
			if (process.platform === "win32")
				expect(after.mode & 0o111).toBe(before.mode & 0o111);
			else expect(after.mode & 0o111).not.toBe(before.mode & 0o111);
			const git = (...args: string[]) =>
				execFileSync("git", args, {
					cwd: root,
					encoding: "utf8",
					env: {
						...process.env,
						GIT_CONFIG_NOSYSTEM: "1",
						GIT_CONFIG_GLOBAL:
							process.platform === "win32" ? "NUL" : "/dev/null",
					},
				});
			git("init", "-q");
			git("add", "run.sh");
			git("update-index", "--chmod=-x", "run.sh");
			const indexBefore = git("ls-files", "--stage", "-z");
			git("update-index", "--chmod=+x", "run.sh");
			const indexAfter = git("ls-files", "--stage", "-z");
			expect(indexBefore.startsWith("100644 ")).toBe(true);
			expect(indexAfter.startsWith("100755 ")).toBe(true);
			expect(indexAfter.slice(7)).toBe(indexBefore.slice(7));
			console.log("NATIVE_MODE_EVIDENCE", {
				platform: process.platform,
				node: process.version,
				beforeMode: before.mode.toString(8),
				afterMode: after.mode.toString(8),
				beforeExec: before.mode & 0o111,
				afterExec: after.mode & 0o111,
				indexBeforeHex: Buffer.from(indexBefore).toString("hex"),
				indexAfterHex: Buffer.from(indexAfter).toString("hex"),
			});
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
	it("records native newline filename feasibility without removing the faithful mock case", async () => {
		const root = await fs.mkdtemp(join(tmpdir(), "qb-baseline-newline-"));
		try {
			let failure: string | undefined;
			try {
				await fs.writeFile(join(root, "line\nbreak.ts"), "two");
			} catch (error) {
				failure = (error as NodeJS.ErrnoException).code;
			}
			if (process.platform === "win32") {
				expect(failure).toBe("ENOENT");
				expect(await fs.readdir(root)).toEqual([]);
			} else {
				expect(failure).toBeUndefined();
				expect(await fs.readdir(root)).toEqual(["line\nbreak.ts"]);
			}
			console.log("NATIVE_NEWLINE_EVIDENCE", {
				platform: process.platform,
				node: process.version,
				pathHex: Buffer.from("line\nbreak.ts").toString("hex"),
				failure,
				nativeFilesystemAcceptance: failure === undefined,
			});
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});

// Original 25 cases remain above. These probes pin the extended-header limitation:
// raw metadata is observable before tar normalizes per-file/GNU paths; global
// path metadata is ignored by tar and must not be mistaken for an effective path.
describe("P1 installed tar metadata boundary evidence", () => {
	for (const type of [
		"ExtendedHeader",
		"GlobalExtendedHeader",
		"NextFileHasLongPath",
	] as const) {
		it(`records raw ${type} bytes independently from effective paths`, async () => {
			const rawPath = "package/a\\b";
			const metadata =
				type === "NextFileHasLongPath"
					? Buffer.from(`${rawPath}\0`)
					: pax(rawPath);
			const bytes = archive([
				{ path: "metadata", type, bytes: metadata },
				{ path: "package/safe", bytes: Buffer.from("fixture") },
			]);
			const rawMetadata: string[] = [];
			const entries: { path: string; headerPath: string }[] = [];
			await new Promise<void>((accept, reject) => {
				const parser = new Parser({ strict: true });
				parser.on("error", reject);
				parser.on("end", accept);
				parser.on("meta", (text) => rawMetadata.push(text));
				parser.on("entry", (entry) => {
					entries.push({ path: entry.path, headerPath: entry.header.path! });
					entry.resume();
				});
				parser.end(bytes);
			});
			expect(rawMetadata).toEqual([metadata.toString("utf8")]);
			expect(bytes.subarray(512, 512 + metadata.length)).toEqual(metadata);
			const expectedPath =
				type === "GlobalExtendedHeader"
					? "package/safe"
					: process.platform === "win32"
						? "package/a/b"
						: rawPath;
			expect(entries.map((entry) => entry.path)).toEqual([expectedPath]);
			console.log(
				"RAW_TAR_METADATA_EVIDENCE",
				JSON.stringify({
					type,
					platform: process.platform,
					node: process.version,
					archiveSha256: sha(bytes),
					archiveBase64: bytes.toString("base64"),
					metadataHex: metadata.toString("hex"),
					rawMetadata,
					entries,
				}),
			);
		});
	}
});

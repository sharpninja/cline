// SPDX-License-Identifier: Apache-2.0
import assert, { AssertionError } from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Header, Parser } from "tar";
import { afterEach, describe, expect, it, vi } from "vitest";
import { preparePluginInstallation } from "./plugin-installation";

const nativeCapture = vi.hoisted(() => ({
	provider: undefined as ScriptedTarProvider | undefined,
	ordinal: 0,
	staging: undefined as string | undefined,
	bytesHash: "",
	fault: "none" as "none" | "wrong-body" | "omit-write",
}));
vi.mock("tar", async (importOriginal) => {
	const actual = await importOriginal<typeof import("tar")>();
	return {
		...actual,
		Parser: class extends actual.Parser {
			constructor(options: ConstructorParameters<typeof actual.Parser>[0]) {
				super(options);
				const provider = nativeCapture.provider;
				if (!provider) return;
				provider.requests.push({
					operation: "parse",
					hash: nativeCapture.bytesHash,
				});
				this.on("entry", (entry) => {
					const ordinal = nativeCapture.ordinal++;
					provider.requests.push({
						operation: "raw",
						ordinal,
						path: entry.header.path,
					});
					provider.requests.push({
						operation: "entry",
						ordinal,
						path: entry.path,
					});
				});
				this.on("end", () => provider.requests.push({ operation: "end" }));
			}
		},
	};
});
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		mkdtempSync: ((...args: Parameters<typeof actual.mkdtempSync>) => {
			const result = actual.mkdtempSync(...args);
			if (nativeCapture.provider && String(args[0]).endsWith("plugin-"))
				nativeCapture.staging = String(result);
			return result;
		}) as typeof actual.mkdtempSync,
		writeFileSync: ((...args: Parameters<typeof actual.writeFileSync>) => {
			const provider = nativeCapture.provider;
			const root = nativeCapture.staging;
			if (provider && root && typeof args[0] === "string") {
				if (nativeCapture.fault === "omit-write") return;
				if (nativeCapture.fault === "wrong-body")
					args[1] = Buffer.from("corrupt");
				actual.writeFileSync(...args);
				const path = `package/${relative(root, args[0]).replace(/\\/g, "/")}`;
				const bytes = actual.readFileSync(args[0]);
				provider.requests.push({
					operation: "write",
					path,
					hash: createHash("sha256").update(bytes).digest("hex"),
				});
				provider.files.set(path, bytes);
				return;
			}
			return actual.writeFileSync(...args);
		}) as typeof actual.writeFileSync,
	};
});

// TEST-QB-003/011. Independent test-only raw archive model, not a production fix.
// The runner preserves the original eleven unsafe path strings and reject/no-write
// assertions. The provider receives only bytes/faults, never expected outcomes.
type Kind =
	| "File"
	| "ExtendedHeader"
	| "GlobalExtendedHeader"
	| "NextFileHasLongPath";
type RecordInput = { path: string; body: string; type?: Kind };
type RawRecord = {
	ordinal: number;
	rawPath: string;
	type: string;
	body: Buffer;
};
type Fault =
	| "none"
	| "normalize-raw"
	| "omit-raw"
	| "entry-before-raw"
	| "omit-entry"
	| "end-before-entry"
	| "wrong-body"
	| "omit-write"
	| "publish-before-write"
	| "omit-publication"
	| "omit-metadata"
	| "normalize-metadata";
const manifest = {
	name: "@sharpninja/mcpserver-cline-v2-plugin",
	version: "1.118.0",
	type: "module",
	main: "dist/index.js",
	exports: { ".": { import: "./dist/index.js" } },
};
const base: RecordInput[] = [
	{ path: "package/package.json", body: JSON.stringify(manifest) },
	{
		path: "package/dist/index.js",
		body: 'throw new Error("Must not execute during installation");',
	},
	{ path: "package/skills/test/SKILL.md", body: "# Test skill" },
	{ path: "package/lib/tool.ps1", body: "Write-Output example" },
	{ path: "package/memory-descriptor.json", body: "{}" },
];
const unsafePaths = [
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
];
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
function archive(records: readonly RecordInput[]): Buffer {
	return Buffer.concat([
		...records.flatMap((record) => {
			const body = Buffer.from(record.body);
			const block = Buffer.alloc(512);
			new Header({
				path: record.path,
				type: record.type ?? "File",
				size: body.length,
				mode: 0o777,
			}).encode(block);
			return [block, body, Buffer.alloc((512 - (body.length % 512)) % 512)];
		}),
		Buffer.alloc(1024),
	]);
}
function pax(path: string): string {
	const value = `path=${path}\n`;
	let length = Buffer.byteLength(value) + 2;
	while (Buffer.byteLength(`${length} ${value}`) !== length)
		length = Buffer.byteLength(`${length} ${value}`);
	return `${length} ${value}`;
}
function rawRecords(bytes: Buffer): RawRecord[] {
	const records: RawRecord[] = [];
	for (let offset = 0; offset + 512 <= bytes.length; ) {
		const h = new Header(bytes, offset);
		if (h.nullBlock) break;
		if (
			!h.cksumValid ||
			h.path === undefined ||
			h.size === undefined ||
			h.size < 0 ||
			offset + 512 + h.size > bytes.length
		)
			throw new Error("invalid raw tar fixture");
		records.push({
			ordinal: records.length,
			rawPath: h.path,
			type: h.type,
			body: Buffer.from(bytes.subarray(offset + 512, offset + 512 + h.size)),
		});
		offset += 512 + Math.ceil(h.size / 512) * 512;
	}
	return records;
}
function metadataPaths(record: RawRecord): string[] {
	if (record.type === "NextFileHasLongPath")
		return [record.body.toString().replace(/\0.*$/s, "")];
	const paths: string[] = [];
	let offset = 0;
	while (offset < record.body.length) {
		const space = record.body.indexOf(32, offset);
		if (space < 0) throw new Error("invalid PAX fixture");
		const length = Number(record.body.subarray(offset, space).toString());
		if (
			!Number.isSafeInteger(length) ||
			length <= space - offset + 1 ||
			offset + length > record.body.length
		)
			throw new Error("invalid PAX fixture");
		const field = record.body
			.subarray(space + 1, offset + length - 1)
			.toString();
		if (field.startsWith("path=")) paths.push(field.slice(5));
		offset += length;
	}
	return paths;
}
interface Callbacks {
	raw(record: RawRecord): void;
	entry(ordinal: number, path: string, body: Buffer): void;
	end(): void;
}
class ScriptedTarProvider {
	readonly requests: {
		operation: string;
		ordinal?: number;
		path?: string;
		hash?: string;
	}[] = [];
	readonly files = new Map<string, Buffer>();
	published = false;
	constructor(readonly fault: Fault = "none") {}
	async parse(bytes: Buffer, callbacks: Callbacks): Promise<void> {
		this.requests.push({ operation: "parse", hash: sha(bytes) });
		let localPath: string | undefined;
		for (const record of rawRecords(bytes)) {
			const raw = {
				...record,
				body:
					this.fault === "normalize-metadata" && record.type !== "File"
						? Buffer.from(record.body.toString().replace(/\\/g, "/"))
						: Buffer.from(record.body),
				rawPath:
					this.fault === "normalize-raw"
						? record.rawPath.replace(/\\/g, "/")
						: record.rawPath,
			};
			const effectivePath = (localPath ?? record.rawPath).replace(/\\/g, "/");
			const emitEntry = () => {
				this.requests.push({
					operation: "entry",
					ordinal: record.ordinal,
					path: effectivePath,
				});
				callbacks.entry(
					record.ordinal,
					effectivePath,
					this.fault === "wrong-body"
						? Buffer.from("corrupt")
						: Buffer.from(record.body),
				);
			};
			if (this.fault === "entry-before-raw" && record.type === "File")
				emitEntry();
			if (
				this.fault !== "omit-raw" &&
				!(this.fault === "omit-metadata" && record.type !== "File")
			) {
				this.requests.push({
					operation: "raw",
					ordinal: record.ordinal,
					path: raw.rawPath,
				});
				callbacks.raw(raw);
			}
			if (record.type !== "File") {
				const paths = metadataPaths(record);
				if (record.type !== "GlobalExtendedHeader") localPath = paths.at(-1);
				continue;
			}
			if (this.fault === "end-before-entry") {
				this.requests.push({ operation: "end" });
				callbacks.end();
			}
			if (this.fault !== "omit-entry" && this.fault !== "entry-before-raw")
				emitEntry();
			localPath = undefined;
		}
		this.requests.push({ operation: "end" });
		callbacks.end();
	}
	write(path: string, body: Buffer): void {
		if (this.fault === "publish-before-write" && !this.published)
			this.publish();
		this.requests.push({ operation: "write", path, hash: sha(body) });
		if (this.fault !== "omit-write") this.files.set(path, Buffer.from(body));
	}
	publish(): void {
		this.requests.push({ operation: "publish" });
		if (this.fault !== "omit-publication") this.published = true;
	}
}
// State and policy belong to the test model; this is not the installed validator.
// Later bind the same runner to a production adapter and capture actual writes.
class RawArchiveModel {
	constructor(readonly provider: ScriptedTarProvider) {}
	async prepare(bytes: Buffer): Promise<{ install(): void }> {
		const files = new Map<string, Buffer>();
		let pending: RawRecord | undefined;
		let next = 0;
		let ended = false;
		const portable = (path: string) => {
			const parts = path.split("/");
			if (
				!path.startsWith("package/") ||
				/[^\x20-\x7e]|[\\:<>"|?*]/.test(path) ||
				parts.some(
					(p) =>
						!p ||
						p === "." ||
						p === ".." ||
						/[. ]$/.test(p) ||
						/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p),
				)
			)
				throw new Error(
					"Required plugin installation is invalid or unavailable.",
				);
		};
		await this.provider.parse(Buffer.from(bytes), {
			raw: (record) => {
				if (ended || pending || record.ordinal !== next++)
					throw new Error("raw callback order");
				if (record.type === "File") {
					portable(record.rawPath);
					pending = record;
				} else {
					for (const path of metadataPaths(record)) portable(path);
				}
			},
			entry: (ordinal, path, body) => {
				if (ended || !pending || pending.ordinal !== ordinal)
					throw new Error("entry callback order");
				portable(path);
				if (files.has(path)) throw new Error("duplicate archive path");
				if (!pending.body.equals(body))
					throw new Error("entry body differs from raw body");
				files.set(path, Buffer.from(body));
				pending = undefined;
			},
			end: () => {
				if (
					ended ||
					pending ||
					!files.has("package/package.json") ||
					!files.has("package/dist/index.js")
				)
					throw new Error("incomplete parser completion");
				ended = true;
			},
		});
		if (!ended) throw new Error("missing parser completion");
		return {
			install: () => {
				for (const [path, body] of files) this.provider.write(path, body);
				this.provider.publish();
			},
		};
	}
}
type Scenario = { records: RecordInput[]; accepted: boolean };
type DriverFactory = (provider: ScriptedTarProvider) => {
	prepare(bytes: Buffer): Promise<{ install(): void }>;
};
// A later production adapter must capture actual filesystem/publication effects here.
// SAME scenario contract for independent models and the released private adapter.
// Errors from prepare/install are observations; only contract assertions qualify
// as rejection controls. Fixture construction and unrelated exceptions propagate.
const contractPrefix = "RAW_ARCHIVE_CONTRACT:";
async function requireScenarioAssertion(run: Promise<void>): Promise<void> {
	let caught: unknown;
	try { await run; } catch (error) { caught = error; }
	assert.ok(
		caught instanceof AssertionError &&
			caught.code === "ERR_ASSERTION" &&
			caught.message.startsWith(contractPrefix),
		"Expected a named scenario assertion, never an incidental model/adapter exception",
	);
	console.log("RAW_ARCHIVE_REJECT_CONTROL", JSON.stringify({
		name: caught.message.split("\n")[0], code: caught.code,
	}));
}
async function assertScenario(
	scenario: Scenario,
	fault: Fault = "none",
	createDriver: DriverFactory = (provider) => new RawArchiveModel(provider),
) {
	const bytes = archive(scenario.records);
	const provider = new ScriptedTarProvider(fault);
	const model = createDriver(provider);
	let prepared: { install(): void } | undefined;
	let prepareError: unknown;
	try { prepared = await model.prepare(bytes); }
	catch (error) { prepareError = error; }
	console.log("RAW_ARCHIVE_PREPARE_OBSERVATION", JSON.stringify({
		fault, archiveSha256: sha(bytes),
		outcome: prepareError === undefined ? "prepared" : "rejected",
		errorType: prepareError instanceof Error ? prepareError.name : typeof prepareError,
		requests: provider.requests,
	}));
	if (!scenario.accepted) {
		// Original reject/no-write assertions and exact raw-boundary checks.
		assert.ok(prepareError instanceof Error, contractPrefix + " rejected prepare");
		assert.deepStrictEqual([...provider.files.keys()], [], contractPrefix + " rejected files");
		assert.strictEqual(provider.published, false, contractPrefix + " rejected publication");
		const firstMetadata = scenario.records.findIndex(
			(record) => record.type !== undefined && record.type !== "File",
		);
		const rejectedAt =
			firstMetadata < 0 ? scenario.records.length - 1 : firstMetadata;
		assert.deepStrictEqual(
			provider.requests.filter((r) => r.operation === "raw").map((r) => r.ordinal),
			Array.from({ length: rejectedAt + 1 }, (_, i) => i),
			contractPrefix + " rejected raw callback order",
		);
		assert.deepStrictEqual(
			provider.requests.filter((r) => r.operation === "write" || r.operation === "publish"),
			[], contractPrefix + " rejected write/publication effects",
		);
	} else {
		assert.strictEqual(prepareError, undefined, contractPrefix + " accepted prepare");
		assert.ok(prepared, contractPrefix + " prepared installation");
		let installError: unknown;
		try { prepared.install(); } catch (error) { installError = error; }
		console.log("RAW_ARCHIVE_INSTALL_OBSERVATION", JSON.stringify({
			fault, archiveSha256: sha(bytes), requests: provider.requests,
			published: provider.published,
			files: [...provider.files].map(([path, body]) => ({ path, sha256: sha(body), bytes: body.toString("base64") })),
			outcome: installError === undefined ? "installed" : "rejected",
			errorType: installError instanceof Error ? installError.name : typeof installError,
		}));
		assert.strictEqual(installError, undefined, contractPrefix + " accepted install");
		assert.strictEqual(provider.published, true, contractPrefix + " accepted publication");
		const expectedFiles = scenario.records.filter(
			(r) => !r.type || r.type === "File",
		);
		assert.deepStrictEqual(
			[...provider.files.keys()], expectedFiles.map((r) => r.path),
			contractPrefix + " exact written paths",
		);
		for (const record of expectedFiles)
			assert.deepStrictEqual(
				provider.files.get(record.path), Buffer.from(record.body),
				contractPrefix + " exact written bytes",
			);
		assert.strictEqual(
			provider.requests.filter((r) => r.operation === "raw").length,
			scenario.records.length, contractPrefix + " accepted raw count",
		);
		assert.strictEqual(
			provider.requests.filter((r) => r.operation === "entry").length,
			expectedFiles.length, contractPrefix + " accepted entry count",
		);
		const effects = provider.requests.filter(
			(r) => r.operation === "write" || r.operation === "publish",
		);
		assert.deepStrictEqual(
			effects.map((r) => r.operation),
			[...expectedFiles.map(() => "write"), "publish"],
			contractPrefix + " exact write/publication order",
		);
	}
	console.log(
		"RAW_ARCHIVE_MODEL_TRACE",
		JSON.stringify({
			fault, archiveSha256: sha(bytes), archiveBase64: bytes.toString("base64"),
			requests: provider.requests, published: provider.published,
			files: [...provider.files.keys()],
		}),
	);
}
const good: Scenario = {
	records: [...base, { path: "package/a/b", body: "bad" }],
	accepted: true,
};
const bad: Scenario = {
	records: [...base, { path: "package/a\\b", body: "bad" }],
	accepted: false,
};
describe("TEST-QB-003/011: raw archive model gate preserves original unsafe cases and rejects faulty dependencies", () => {
	it("rejection qualifier refuses incidental errors, missing rejection and wrong assertion identity", async () => {
		for (const failure of [
			() => Promise.reject(new Error("incidental parser failure")),
			() => Promise.resolve(),
			() => Promise.reject(new Error(contractPrefix + " ordinary error spoof")),
			() => Promise.reject(new AssertionError({ message: "other contract", actual: 1, expected: 2, operator: "strictEqual" })),
		]) {
			await assert.rejects(requireScenarioAssertion(failure()), (error: unknown) =>
				error instanceof AssertionError && error.code === "ERR_ASSERTION" &&
				error.message.startsWith("Expected a named scenario assertion"));
		}
	});
	it("accepts portable original bytes and publishes only after complete writes", () =>
		assertScenario(good));
	for (const path of unsafePaths)
		it(`original unsafe path ${path} rejects before writes`, () =>
			assertScenario({
				records: [...base, { path, body: "bad" }],
				accepted: false,
			}));
	for (const type of [
		"ExtendedHeader",
		"GlobalExtendedHeader",
		"NextFileHasLongPath",
	] as const)
		it(`raw ${type} backslash rejected before normalized entry or publication`, () =>
			assertScenario({
				records: [
					...base,
					{
						path: "metadata",
						type,
						body:
							type === "NextFileHasLongPath"
								? "package/a\\b\0"
								: pax("package/a\\b"),
					},
					{ path: "package/safe", body: "bad" },
				],
				accepted: false,
			}));
	for (const type of [
		"ExtendedHeader",
		"GlobalExtendedHeader",
		"NextFileHasLongPath",
	] as const) {
		it(`accepts portable ${type} through the same model assertions`, () =>
			assertScenario({
				records: [
					...base,
					{
						path: "metadata",
						type,
						body:
							type === "NextFileHasLongPath"
								? "package/safe\0"
								: pax("package/safe"),
					},
					{ path: "package/safe", body: "bad" },
				],
				accepted: true,
			}));
		for (const fault of ["omit-metadata", "normalize-metadata"] as const)
			it(`same ${type} rejection assertions reject ${fault}`, async () => {
				await requireScenarioAssertion(
					assertScenario(
						{
							records: [
								...base,
								{
									path: "metadata",
									type,
									body:
										type === "NextFileHasLongPath"
											? "package/a\\b\0"
											: pax("package/a\\b"),
								},
								{ path: "package/safe", body: "bad" },
							],
							accepted: false,
						},
						fault,
					),
				);
			});
	}
	for (const fault of [
		"normalize-raw",
		"omit-raw",
		"entry-before-raw",
	] as const)
		it(`same original rejection assertions reject ${fault}`, async () => {
			await requireScenarioAssertion(assertScenario(bad, fault));
		});
	for (const fault of [
		"omit-raw",
		"entry-before-raw",
		"omit-entry",
		"end-before-entry",
		"wrong-body",
		"omit-write",
		"publish-before-write",
		"omit-publication",
	] as const)
		it(`same accepted scenario assertions reject ${fault}`, async () => {
			await requireScenarioAssertion(assertScenario(good, fault));
		});
});

async function parserEvidence(bytes: Buffer) {
	const events: {
		operation: string;
		path?: string;
		rawPath?: string;
		hex?: string;
	}[] = [];
	await new Promise<void>((accept, reject) => {
		const parser = new Parser({ strict: true });
		parser.on("meta", (text) =>
			events.push({
				operation: "meta",
				hex: Buffer.from(text).toString("hex"),
			}),
		);
		parser.on("entry", (entry) => {
			events.push({
				operation: "entry",
				path: entry.path,
				rawPath: entry.header.path,
			});
			entry.resume();
		});
		parser.on("error", reject);
		parser.on("end", accept);
		parser.end(bytes);
	});
	return events;
}
describe("source-backed native tar raw-byte observability, separate from model acceptance", () => {
	it("retains original backslash bytes while native parser exposes its normalization", async () => {
		const bytes = archive(bad.records);
		const events = await parserEvidence(bytes);
		const last = events.at(-1);
		if (!last) throw new Error("Native parser returned no entry evidence");
		expect(rawRecords(bytes).at(-1)?.rawPath).toBe("package/a\\b");
		expect(last.rawPath).toBe("package/a\\b");
		expect(last.path).toBe(
			process.platform === "win32" ? "package/a/b" : "package/a\\b",
		);
		console.log(
			"NATIVE_RAW_TAR_EVIDENCE",
			JSON.stringify({
				platform: process.platform,
				sha256: sha(bytes),
				base64: bytes.toString("base64"),
				events,
			}),
		);
	});
	for (const type of [
		"ExtendedHeader",
		"GlobalExtendedHeader",
		"NextFileHasLongPath",
	] as const)
		it(`captures actual ${type} bytes and effective header path without claiming ignored global path applied`, async () => {
			const bytes = archive([
				...base,
				{
					path: "metadata",
					type,
					body:
						type === "NextFileHasLongPath"
							? "package/a\\b\0"
							: pax("package/a\\b"),
				},
				{ path: "package/safe", body: "bad" },
			]);
			const events = await parserEvidence(bytes);
			expect(events.filter((e) => e.operation === "meta")).toHaveLength(1);
			expect(events.at(-1)?.rawPath).toBe(
				type === "GlobalExtendedHeader" ? "package/safe" : "package/a\\b",
			);
			console.log(
				"NATIVE_RAW_TAR_EVIDENCE",
				JSON.stringify({
					platform: process.platform,
					type,
					sha256: sha(bytes),
					base64: bytes.toString("base64"),
					events,
				}),
			);
		});
});

// Production binding uses the same assertScenario, original inputs and assertions.
// No scripted parser is called: public tar callbacks and real filesystem effects
// populate the observation object. Metadata raw-record timing remains OPEN.
const nativeParents: string[] = [];
afterEach(() => {
	nativeCapture.provider = undefined;
	nativeCapture.staging = undefined;
	nativeCapture.fault = "none";
	for (const parent of nativeParents.splice(0))
		rmSync(parent, { recursive: true, force: true });
});
function nativeDriver(
	fault: typeof nativeCapture.fault = "none",
): DriverFactory {
	return (provider) => ({
		async prepare(bytes) {
			const parent = mkdtempSync(join(tmpdir(), "qb-raw-production-"));
			nativeParents.push(parent);
			nativeCapture.provider = provider;
			nativeCapture.ordinal = 0;
			nativeCapture.staging = undefined;
			nativeCapture.bytesHash = sha(bytes);
			nativeCapture.fault = fault;
			try {
				const prepared = await preparePluginInstallation({
					bytes,
					binding: {
						pluginName: manifest.name,
						pluginVersion: manifest.version,
						artifactSha256: sha(bytes),
					},
					requiredFiles: [
						"skills/test/SKILL.md",
						"lib/tool.ps1",
						"memory-descriptor.json",
					],
				});
				return {
					install() {
						const installed = prepared.install(parent);
						const verified = prepared.verify(installed.root);
						provider.published =
							verified.root === installed.root &&
							readFileSync(installed.entrypoint).length > 0;
						provider.requests.push({
							operation: "publish",
							path: installed.root,
						});
					},
				};
			} catch (error) {
				expect(readdirSync(parent)).toEqual([]);
				throw error;
			}
		},
	});
}
describe("released production effective-path binding with actual parser and filesystem effects", () => {
	it("same assertions install the original five-file manifest fixture", () =>
		assertScenario(
			{ records: [...base], accepted: true },
			"none",
			nativeDriver(),
		));
	it("same assertions install the original portable six-file scenario", () =>
		assertScenario(good, "none", nativeDriver()));
	for (const path of unsafePaths)
		it(`same original unsafe input ${path} rejects with no write/publication`, () =>
			assertScenario(
				{ records: [...base, { path, body: "bad" }], accepted: false },
				"none",
				nativeDriver(),
			));
	for (const fault of ["wrong-body", "omit-write"] as const)
		it(`same original accepted assertions reject actual filesystem ${fault}`, async () => {
			await requireScenarioAssertion(
				assertScenario(good, "none", nativeDriver(fault)),
			);
		});
	for (const type of ["ExtendedHeader", "NextFileHasLongPath"] as const)
		it(`effective ${type} backslash rejects in production before disk writes`, async () => {
			const provider = new ScriptedTarProvider();
			const driver = nativeDriver()(provider);
			const bytes = archive([
				...base,
				{
					path: "metadata",
					type,
					body:
						type === "NextFileHasLongPath"
							? "package/a\\b\0"
							: pax("package/a\\b"),
				},
				{ path: "package/safe", body: "bad" },
			]);
			await expect(driver.prepare(bytes)).rejects.toThrow();
			expect([...provider.files.keys()]).toEqual([]);
			expect(provider.published).toBe(false);
			expect(
				provider.requests.filter(
					(r) => r.operation === "write" || r.operation === "publish",
				),
			).toEqual([]);
			expect(
				provider.requests.filter((r) => r.operation === "raw").at(-1)?.path,
			).toBe("package/a\\b");
			console.log(
				"PRODUCTION_EFFECTIVE_METADATA_TRACE",
				JSON.stringify({
					type,
					archiveSha256: sha(bytes),
					archiveBase64: bytes.toString("base64"),
					requests: provider.requests,
					files: [...provider.files.keys()],
					published: provider.published,
				}),
			);
		});
});

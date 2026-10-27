// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { Parser } from "tar";

export interface PluginInstallationBinding {
	readonly pluginName: string;
	readonly pluginVersion: string;
	readonly artifactSha256: string;
}

export interface InstalledPlugin {
	readonly root: string;
	readonly entrypoint: string;
	readonly binding: Readonly<PluginInstallationBinding>;
}

export interface PreparedPluginInstallation {
	readonly binding: Readonly<PluginInstallationBinding>;
	readonly fileCount: number;
	/** Existing, host-owned private product directory. Never use model input. */
	install(parentDirectory: string): InstalledPlugin;
	/** Recheck immediately before loading. The expected inventory remains in memory. */
	verify(rootDirectory: string): InstalledPlugin;
}

const failure = () =>
	new Error("Required plugin installation is invalid or unavailable.");
const digest = (bytes: Uint8Array) =>
	createHash("sha256").update(bytes).digest("hex");
const maxArchiveBytes = 64 * 1024 * 1024;
const maxExpandedBytes = 256 * 1024 * 1024;
const maxFileBytes = 32 * 1024 * 1024;
const maxEntries = 4096;

/** Intentionally portable: no Windows aliases, Unicode aliases, links or dot components. */
function portablePath(path: string): string {
	if (!path || path.length > 240 || /[^\x20-\x7e]|[\\:<>"|?*]/.test(path))
		throw failure();
	const parts = path.split("/");
	if (
		parts.some(
			(part) =>
				!part ||
				part === "." ||
				part === ".." ||
				/[. ]$/.test(part) ||
				/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part),
		)
	)
		throw failure();
	return path;
}

function checkedDirectory(path: string): string {
	if (!isAbsolute(path)) throw failure();
	const absolute = resolve(path);
	let current = absolute;
	for (;;) {
		const stat = lstatSync(current);
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure();
		const parent = dirname(current);
		if (parent === current) return absolute;
		current = parent;
	}
}

function hashInstalledFile(path: string, size: number): string {
	const stat = lstatSync(path);
	if (
		!stat.isFile() ||
		stat.isSymbolicLink() ||
		stat.nlink !== 1 ||
		stat.size !== size
	)
		throw failure();
	const fd = openSync(
		path,
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	try {
		const opened = fstatSync(fd);
		if (!opened.isFile() || opened.nlink !== 1 || opened.size !== size)
			throw failure();
		const hash = createHash("sha256");
		const buffer = Buffer.alloc(Math.min(size + 1, 64 * 1024));
		let remaining = size;
		while (remaining > 0) {
			const count = readSync(
				fd,
				buffer,
				0,
				Math.min(buffer.length, remaining),
				null,
			);
			if (!count) throw failure();
			hash.update(buffer.subarray(0, count));
			remaining -= count;
		}
		if (readSync(fd, buffer, 0, 1, null) !== 0) throw failure();
		return hash.digest("hex");
	} finally {
		closeSync(fd);
	}
}

/**
 * Accept bytes from the signed-pin verifier, never reopen its source path. Rehash
 * the private copy at this boundary. Parsing and manifest validation do no I/O.
 * Required assets are selected by the host's reviewed package contract.
 */
export async function preparePluginInstallation(options: {
	bytes: Uint8Array;
	binding: PluginInstallationBinding;
	requiredFiles: readonly string[];
}): Promise<PreparedPluginInstallation> {
	try {
		if (
			!(options.bytes instanceof Uint8Array) ||
			!options.bytes.length ||
			options.bytes.length > maxArchiveBytes ||
			!options.binding.pluginName?.trim() ||
			!options.binding.pluginVersion?.trim() ||
			!/^[a-f0-9]{64}$/i.test(options.binding.artifactSha256)
		)
			throw failure();
		const binding = Object.freeze({
			...options.binding,
			artifactSha256: options.binding.artifactSha256.toLowerCase(),
		});
		const bytes = Buffer.from(options.bytes);
		if (digest(bytes) !== binding.artifactSha256) throw failure();
		// Bound all decompressed bytes, including PAX metadata and ignored padding.
		const unpacked =
			bytes[0] === 0x1f && bytes[1] === 0x8b
				? gunzipSync(bytes, { maxOutputLength: maxExpandedBytes })
				: bytes;
		// Never allow recursive decompression inside the tar parser.
		if (unpacked[0] === 0x1f && unpacked[1] === 0x8b) throw failure();
		const requiredFiles = [
			"package.json",
			"dist/index.js",
			...options.requiredFiles,
		].map(portablePath);
		const files = new Map<string, Buffer>();
		const directories = new Set<string>();
		const seen = new Set<string>();
		const aliases = new Map<string, string>();
		let entries = 0;
		let expanded = 0;
		await new Promise<void>((accept, reject) => {
			const parser = new Parser({
				strict: true,
				maxMetaEntrySize: 64 * 1024,
				maxDecompressionRatio: 1,
				zstd: false,
				brotli: false,
			});
			const fail = () => parser.abort(failure());
			parser.on("error", () => reject(failure()));
			parser.on("ignoredEntry", fail);
			parser.on("end", accept);
			parser.on("entry", (entry) => {
				try {
					if (
						++entries > maxEntries ||
						!["File", "Directory"].includes(entry.type) ||
						entry.linkpath
					)
						throw failure();
					const directory = entry.type === "Directory";
					portablePath(
						directory
							? entry.header.path.replace(/\/$/, "")
							: entry.header.path,
					);
					const fullPath = portablePath(
						directory ? entry.path.replace(/\/$/, "") : entry.path,
					);
					if (fullPath !== "package" && !fullPath.startsWith("package/"))
						throw failure();
					if (seen.has(fullPath)) throw failure();
					seen.add(fullPath);
					if (
						!Number.isSafeInteger(entry.size) ||
						entry.size < 0 ||
						entry.size > maxFileBytes ||
						(directory && entry.size !== 0) ||
						(expanded += entry.size) > maxExpandedBytes
					)
						throw failure();
					if (fullPath === "package") {
						if (!directory) throw failure();
						entry.resume();
						return;
					}
					const path = fullPath.slice(8);
					const parts = path.split("/");
					for (let index = 1; index <= parts.length; index++) {
						const part = parts.slice(0, index).join("/");
						const prior = aliases.get(part.toLowerCase());
						if (prior !== undefined && prior !== part) throw failure();
						aliases.set(part.toLowerCase(), part);
						if (index < parts.length || directory) directories.add(part);
					}
					const chunks: Buffer[] = [];
					let count = 0;
					entry.on("data", (chunk: Buffer) => {
						count += chunk.length;
						if (count > entry.size) {
							fail();
							return;
						}
						chunks.push(Buffer.from(chunk));
					});
					entry.on("end", () => {
						if (count !== entry.size) {
							fail();
							return;
						}
						if (!directory) files.set(path, Buffer.concat(chunks, count));
					});
					entry.resume();
				} catch {
					fail();
				}
			});
			parser.end(unpacked);
		});
		if (
			requiredFiles.some((path) => !files.has(path)) ||
			[...directories].some((path) => files.has(path))
		)
			throw failure();
		const manifest = JSON.parse(files.get("package.json")!.toString("utf8"));
		if (
			manifest.name !== binding.pluginName ||
			manifest.version !== binding.pluginVersion ||
			manifest.type !== "module" ||
			manifest.main !== "dist/index.js" ||
			manifest.exports?.["."]?.import !== "./dist/index.js"
		)
			throw failure();
		const hashes = new Map(
			[...files].map(([path, content]) => [path, digest(content)]),
		);
		function verify(rootDirectory: string): InstalledPlugin {
			try {
				const root = checkedDirectory(rootDirectory);
				let count = 0;
				const walk = (directory: string, prefix: string) => {
					for (const entry of readdirSync(directory, { withFileTypes: true })) {
						const path = prefix + entry.name;
						if (entry.isDirectory() && directories.has(path))
							walk(join(directory, entry.name), path + "/");
						else if (entry.isFile() && files.has(path)) {
							if (
								hashInstalledFile(
									join(directory, entry.name),
									files.get(path)!.length,
								) !== hashes.get(path)
							)
								throw failure();
							count++;
						} else throw failure();
					}
				};
				walk(root, "");
				if (
					count !== files.size ||
					[...directories].some(
						(path) => !lstatSync(join(root, path)).isDirectory(),
					)
				)
					throw failure();
				return Object.freeze({
					root,
					entrypoint: join(root, "dist/index.js"),
					binding,
				});
			} catch {
				throw failure();
			}
		}
		return Object.freeze({
			binding,
			fileCount: files.size,
			verify,
			install(parentDirectory: string): InstalledPlugin {
				let staging: string | undefined;
				try {
					const parent = checkedDirectory(parentDirectory);
					staging = mkdtempSync(join(parent, "plugin-"));
					for (const path of [...directories].sort(
						(a, b) => a.split("/").length - b.split("/").length,
					))
						mkdirSync(join(staging, path), { mode: 0o700 });
					for (const [path, content] of files)
						writeFileSync(join(staging, path), content, {
							flag: "wx",
							mode: 0o600,
						});
					return verify(staging);
				} catch {
					if (staging) {
						try {
							rmSync(staging, { recursive: true, force: true });
						} catch {
							/* Never mask validation failure. */
						}
					}
					throw failure();
				}
			},
		});
	} catch {
		throw failure();
	}
}

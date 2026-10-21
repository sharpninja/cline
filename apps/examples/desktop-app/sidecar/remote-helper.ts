import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type RemoteHelperTarget,
	remoteHelperBinaryFilename,
} from "@cline/core";
import { isBunEmbeddedModulePath } from "@cline/shared";

// A resource may not redirect to a sibling product through a file or directory
// symlink. Resolve the trusted install/source anchor once, then require the
// exact expected relative path underneath it.
function ownedFile(path: string, anchor: string): string | undefined {
	try {
		const rel = relative(anchor, path);
		if (rel === ".." || rel.startsWith("../") || rel.startsWith("..\\"))
			return undefined;
		const expected = resolve(realpathSync(anchor), rel);
		const actual = realpathSync(path);
		return actual === expected && statSync(actual).isFile()
			? actual
			: undefined;
	} catch {
		return undefined;
	}
}
const MACHO_FAT_MAGIC = 0xcafebabe;
const MACHO_64_MAGIC = 0xfeedfacf;
const MACHO_CPU_TYPE: Record<RemoteHelperTarget["arch"], number> = {
	arm64: 0x0100000c,
	x64: 0x01000007,
};

// Published desktop builds are universal, but `package:desktop:mac` and local
// `tauri build` produce a thin host-arch sidecar that cannot run on a Mac of
// the other architecture. A fat binary starts with a big-endian magic; a thin
// 64-bit Mach-O starts with its little-endian magic followed by the cputype.
function machoRunsOn(path: string, arch: RemoteHelperTarget["arch"]): boolean {
	const header = Buffer.alloc(8);
	try {
		const fd = openSync(path, "r");
		try {
			readSync(fd, header, 0, 8, 0);
		} finally {
			closeSync(fd);
		}
	} catch {
		return false;
	}
	if (header.readUInt32BE(0) === MACHO_FAT_MAGIC) return true;
	return (
		header.readUInt32LE(0) === MACHO_64_MAGIC &&
		header.readUInt32LE(4) === MACHO_CPU_TYPE[arch]
	);
}

export function resolveDesktopRemoteHelper(
	target: RemoteHelperTarget,
	options: {
		execPath?: string;
		cwd?: string;
		env?: NodeJS.ProcessEnv;
		platform?: NodeJS.Platform;
		sourceDirectory?: string | null;
	} = {},
): string | undefined {
	// cwd and upstream environment overrides intentionally cannot select code.
	const execPath = options.execPath ?? process.execPath;
	const platform = options.platform ?? process.platform;
	const source =
		options.sourceDirectory !== undefined
			? options.sourceDirectory
			: isBunEmbeddedModulePath(import.meta.url)
				? null
				: fileURLToPath(new URL("..", import.meta.url));
	const filename = remoteHelperBinaryFilename(target);
	const bundled = join("bin", "remote-helpers", filename);
	const candidates: Array<[string, string, boolean]> = [];
	const add = (path: string, anchor: string, mac = false) =>
		candidates.push([path, anchor, mac]);
	// System Bun/Node install directories are not product bundle roots.
	if (
		/^cline-qb-sidecar(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?(?:\.exe)?$/.test(
			basename(execPath),
		)
	) {
		const directory = dirname(execPath);
		if (platform === "darwin" && target.platform === "darwin")
			add(execPath, directory, true);
		add(join(directory, "remote-helpers", filename), directory);
		add(join(directory, bundled), directory);
		const parent = dirname(directory);
		add(join(parent, "Resources", bundled), parent);
		if (platform === "linux")
			for (const product of [
				"cline-qb",
				"cline-qb beta",
				"cline-qb dev",
				"cline-qb nightly",
			]) {
				add(join(parent, "lib", product, bundled), parent);
			}
	}
	// In a source run this is derived from this module, never the opened project.
	// Compiled helpers have no source fallback.
	if (source) {
		if (platform === "darwin" && target.platform === "darwin") {
			const triple =
				target.arch === "arm64"
					? "aarch64-apple-darwin"
					: "x86_64-apple-darwin";
			add(
				join(source, "src-tauri/bin", `cline-qb-sidecar-${triple}`),
				source,
				true,
			);
		}
		add(join(source, "src-tauri", bundled), source);
	}
	for (const [path, anchor, mac] of candidates) {
		const owned = ownedFile(path, anchor);
		if (owned && (!mac || machoRunsOn(owned, target.arch))) return owned;
	}
	return undefined;
}

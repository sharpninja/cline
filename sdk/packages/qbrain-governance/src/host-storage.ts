// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
	registerStorageNamespace,
	type StorageNamespace,
} from "@cline/shared/storage";
import { createQbrainStorageNamespace } from "./storage-policy";

export function resolveHostDocumentsDirectories(options: {
	homeDir: string;
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	queryWindowsDocuments?: () => string;
}): string[] {
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const home = resolve(options.homeDir);
	if (platform === "win32") {
		const query =
			options.queryWindowsDocuments ??
			(() => {
				const systemRoot = env.SystemRoot || env.WINDIR;
				if (!systemRoot || !isAbsolute(systemRoot))
					throw new Error(
						"Cannot resolve Windows known Documents folder: SystemRoot is missing.",
					);
				return execFileSync(
					join(
						systemRoot,
						"System32",
						"WindowsPowerShell",
						"v1.0",
						"powershell.exe",
					),
					[
						"-NoLogo",
						"-NoProfile",
						"-NonInteractive",
						"-Command",
						'[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); [Environment]::GetFolderPath("MyDocuments")',
					],
					{ encoding: "utf8", timeout: 10000, windowsHide: true },
				);
			});
		const documents = query().trim();
		if (!documents || !isAbsolute(documents))
			throw new Error(
				"Cannot resolve an absolute Windows known Documents folder.",
			);
		return [documents];
	}
	if (platform !== "linux") return [join(home, "Documents")];
	const policy = createQbrainStorageNamespace({ homeDir: home, env });
	const config = policy.validatePath(
		join(
			env.XDG_CONFIG_HOME?.trim() || join(home, ".config"),
			"user-dirs.dirs",
		),
	);
	let text: string;
	try {
		text = readFileSync(config, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			return [join(home, "Documents")];
		throw error;
	}
	const lines = text
		.split(/\r?\n/)
		.filter((line) => /^\s*XDG_DOCUMENTS_DIR\s*=/.test(line));
	if (!lines.length) return [join(home, "Documents")];
	const match =
		/^\s*XDG_DOCUMENTS_DIR\s*=\s*"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/.exec(
			lines[lines.length - 1]!,
		);
	if (!match) throw new Error("Malformed XDG_DOCUMENTS_DIR in user-dirs.dirs.");
	if (/\\[$`]/.test(match[1]!))
		throw new Error(
			"Escaped variable syntax is not supported in XDG_DOCUMENTS_DIR.",
		);
	const value = match[1]!
		.replace(/\\([\\"$`])/g, "$1")
		.replace(/\$\{HOME\}|\$HOME(?=\/|$)/g, home);
	if (!isAbsolute(value) || /[$`]/.test(value))
		throw new Error(
			"XDG_DOCUMENTS_DIR must resolve to an absolute literal path.",
		);
	return [resolve(value)];
}

const hostKey = Symbol.for("@cline/qbrain-governance/storage-host/v1");
type HostGlobal = typeof globalThis & {
	[hostKey]?: {
		readonly homeDir: string;
		readonly namespace: StorageNamespace;
	};
};

/** Call before storage-bearing imports. Repeat calls share the same immutable policy. */
export function initializeQbrainStorage(): StorageNamespace {
	const homeDir = resolve(homedir());
	const existing = (globalThis as HostGlobal)[hostKey];
	if (existing && existing.homeDir !== homeDir)
		throw new Error(
			"The operator home cannot change after cline-qb storage initialization.",
		);
	const namespace =
		existing?.namespace ??
		createQbrainStorageNamespace({
			homeDir,
			documentsDirs: resolveHostDocumentsDirectories({ homeDir }),
		});
	// Fail before importing services if any approved storage override is unsafe.
	for (const kind of [
		"root",
		"data",
		"sessions",
		"providerSettings",
		"globalSettings",
		"mcpSettings",
	] as const)
		namespace.resolvePath(kind, { homeDir });
	registerStorageNamespace(namespace);
	if (!existing)
		Object.defineProperty(globalThis, hostKey, {
			value: Object.freeze({ homeDir, namespace }),
			writable: false,
			configurable: false,
		});
	return namespace;
}

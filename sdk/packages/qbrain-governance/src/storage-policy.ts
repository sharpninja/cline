// SPDX-License-Identifier: Apache-2.0
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
	StorageNamespace,
	StoragePathContext,
	StoragePathKind,
} from "@cline/shared/storage";

export interface QbrainStorageOptions {
	/** Real operator home, captured by the executable before loading storage services. */
	readonly homeDir: string;
	readonly env?: NodeJS.ProcessEnv;
	/** Documents directories resolved by the host OS, in addition to conventional locations. */
	readonly documentsDirs?: readonly string[];
}

function errorCode(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException)?.code;
}

/** Resolve existing ancestors, including dangling symlinks, without creating anything. */
function canonicalPath(path: string, depth = 0): string {
	if (depth > 128)
		throw new Error("Storage path has excessive nesting or a symlink cycle.");
	try {
		return realpathSync.native(path);
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw error;
	}
	try {
		if (lstatSync(path).isSymbolicLink()) {
			return canonicalPath(
				resolve(dirname(path), readlinkSync(path)),
				depth + 1,
			);
		}
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw error;
	}
	const parent = dirname(path);
	if (parent === path)
		throw new Error("Storage path has no resolvable filesystem root.");
	return join(
		canonicalPath(parent, depth + 1),
		path.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)),
	);
}

function within(root: string, candidate: string): boolean {
	const normalize = (value: string) =>
		process.platform === "win32" ? value.toLowerCase() : value;
	const child = relative(normalize(root), normalize(candidate));
	return (
		child === "" ||
		(child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))
	);
}

function expandPath(value: string, home: string): string {
	const trimmed = value.trim().replace(/^"(.*)"$/, "$1");
	const expanded = trimmed.replace(/\$\{HOME\}|\$HOME(?=\/|\\|$)/g, home);
	return resolve(
		expanded === "~"
			? home
			: /^~[/\\]/.test(expanded)
				? join(home, expanded.slice(2))
				: expanded,
	);
}

export function createQbrainStorageNamespace(
	options: QbrainStorageOptions,
): StorageNamespace {
	if (!options.homeDir.trim() || !isAbsolute(options.homeDir))
		throw new Error("cline-qb storage requires an absolute home directory.");
	const home = resolve(options.homeDir);
	const env = options.env ?? process.env;
	const documentsDirs = [...(options.documentsDirs ?? [])];
	function excludedRoots(): string[] {
		const documents = [join(home, "Documents"), ...documentsDirs];
		for (const key of ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"]) {
			const value = env[key]?.trim();
			if (value) documents.push(join(expandPath(value, home), "Documents"));
		}
		if (env.XDG_DOCUMENTS_DIR?.trim())
			documents.push(expandPath(env.XDG_DOCUMENTS_DIR, home));
		return [
			join(home, ".cline"),
			join(home, "Cline"),
			...documents.map((path) => join(expandPath(path, home), "Cline")),
		];
	}
	function checked(value: string): string {
		const path = expandPath(value, home);
		const excluded = excludedRoots();
		if (excluded.some((root) => within(root, path)))
			throw new Error(
				`cline-qb storage cannot use upstream Cline path: ${path}`,
			);
		const canonical = canonicalPath(path);
		if (
			excluded.some(
				(root) =>
					within(root, canonical) || within(canonicalPath(root), canonical),
			)
		) {
			throw new Error(
				`cline-qb storage cannot use an alias of upstream Cline storage: ${path}`,
			);
		}
		return canonical;
	}
	function resolvePath(
		kind: StoragePathKind,
		context: StoragePathContext,
	): string {
		const root = checked(
			context.rootOverride?.trim() ||
				env.CLINE_QB_DIR?.trim() ||
				join(home, ".cline-qb"),
		);
		if (kind === "root" || kind === "documents") return root;
		const data = checked(env.CLINE_QB_DATA_DIR?.trim() || join(root, "data"));
		const defaults = {
			data,
			sessions: env.CLINE_QB_SESSION_DATA_DIR?.trim() || join(data, "sessions"),
			teams: join(data, "teams"),
			connectors: join(data, "connectors"),
			connectorSettings: join(data, "connectors", "settings.json"),
			database: join(data, "db"),
			connectorsDatabase: join(data, "db", "connectors.db"),
			cronDatabase: join(data, "db", "cron.db"),
			tasksDatabase: join(data, "db", "tasks.db"),
			providerSettings:
				env.CLINE_QB_PROVIDER_SETTINGS_PATH?.trim() ||
				join(data, "settings", "providers.json"),
			globalSettings:
				env.CLINE_QB_GLOBAL_SETTINGS_PATH?.trim() ||
				join(data, "settings", "global-settings.json"),
			mcpSettings:
				env.CLINE_QB_MCP_SETTINGS_PATH?.trim() ||
				join(data, "settings", "cline_mcp_settings.json"),
		};
		const selected = defaults[kind];
		if (typeof selected !== "string")
			throw new Error("Unsupported cline-qb storage path kind.");
		return checked(selected);
	}
	return Object.freeze({
		validatePath: checked,
		resolvePath,
		globalRulesPaths(context: StoragePathContext) {
			const root = resolvePath("root", context);
			return [checked(join(root, "rules")), checked(join(root, "Rules"))];
		},
	});
}

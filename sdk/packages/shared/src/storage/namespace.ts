// SPDX-License-Identifier: Apache-2.0
/** Host-owned storage policy. Library consumers retain the default namespace. */
export type StoragePathKind =
	| "root"
	| "data"
	| "sessions"
	| "teams"
	| "connectors"
	| "connectorSettings"
	| "database"
	| "connectorsDatabase"
	| "cronDatabase"
	| "tasksDatabase"
	| "providerSettings"
	| "globalSettings"
	| "mcpSettings"
	| "documents";

export interface StoragePathContext {
	readonly homeDir: string;
	readonly rootOverride?: string;
}

export interface StorageNamespace {
	readonly validatePath: (path: string) => string;
	readonly resolvePath: (
		kind: StoragePathKind,
		context: StoragePathContext,
	) => string;
	readonly globalRulesPaths: (context: StoragePathContext) => readonly string[];
}

// Shared across independently bundled @cline/shared entrypoints in one process.
const namespaceKey = Symbol.for("@cline/shared/storage-namespace/v1");
type NamespaceGlobal = typeof globalThis & {
	[namespaceKey]?: StorageNamespace;
};

export function getStorageNamespace(): StorageNamespace | undefined {
	return (globalThis as NamespaceGlobal)[namespaceKey];
}

/** Register before constructing storage services. A host policy cannot be replaced. */
export function registerStorageNamespace(namespace: StorageNamespace): void {
	if (
		typeof namespace?.resolvePath !== "function" ||
		typeof namespace.globalRulesPaths !== "function" ||
		typeof namespace.validatePath !== "function"
	) {
		throw new Error(
			"A storage namespace requires path and global-rule resolvers.",
		);
	}
	const existing = getStorageNamespace();
	if (existing) {
		if (
			existing.resolvePath === namespace.resolvePath &&
			existing.globalRulesPaths === namespace.globalRulesPaths &&
			existing.validatePath === namespace.validatePath
		)
			return;
		throw new Error("The host storage namespace is already registered.");
	}
	Object.defineProperty(globalThis, namespaceKey, {
		value: Object.freeze({
			resolvePath: namespace.resolvePath,
			globalRulesPaths: namespace.globalRulesPaths,
			validatePath: namespace.validatePath,
		}),
		writable: false,
		configurable: false,
	});
}
/** Apply a host policy to explicit paths and children derived from approved roots. */
export function validateStoragePath(path: string): string {
	const namespace = getStorageNamespace();
	if (!namespace) return path;
	const result = namespace.validatePath(path);
	if (typeof result !== "string" || !result.trim())
		throw new Error("Host storage policy returned an invalid path.");
	return result;
}

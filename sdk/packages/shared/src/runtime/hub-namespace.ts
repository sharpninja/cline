// SPDX-License-Identifier: Apache-2.0
import { isAbsolute } from "node:path";
/** Host-owned endpoint and discovery names; unregistered SDK consumers keep their defaults. */
export interface HubNamespace {
	/** Refuse hub operations until trusted bootstrap registers peer identity. */
	readonly requirePeerIdentity?: boolean;
	readonly hostVariable: string;
	readonly portVariable: string;
	readonly discoveryVariable: string;
	readonly defaultHost: string;
	readonly productionPort: number;
	readonly developmentPort: number;
	readonly pathname: string;
}
const namespaceKey = Symbol.for("@cline/shared/hub-namespace/v1");
type NamespaceGlobal = typeof globalThis & {
	[namespaceKey]?: Readonly<HubNamespace>;
};
export function getHubNamespace(): Readonly<HubNamespace> | undefined {
	return (globalThis as NamespaceGlobal)[namespaceKey];
}
/** Register before hub discovery or connection. Configuration cannot be replaced afterward. */
export function registerHubNamespace(namespace: HubNamespace): void {
	const keys = ["hostVariable", "portVariable", "discoveryVariable"] as const;
	if (
		!namespace ||
		keys.some((key) => !/^[A-Z][A-Z0-9_]*$/.test(namespace[key])) ||
		!namespace.defaultHost?.trim() ||
		!namespace.pathname?.startsWith("/") ||
		/[?#]/.test(namespace.pathname) ||
		[namespace.productionPort, namespace.developmentPort].some(
			(port) => !Number.isSafeInteger(port) || port < 1 || port > 65535,
		)
	) {
		throw new Error(
			"A hub namespace requires valid environment names, endpoint defaults, and ports.",
		);
	}
	const value = Object.freeze({
		requirePeerIdentity: namespace.requirePeerIdentity === true,
		hostVariable: namespace.hostVariable,
		portVariable: namespace.portVariable,
		discoveryVariable: namespace.discoveryVariable,
		defaultHost: namespace.defaultHost,
		productionPort: namespace.productionPort,
		developmentPort: namespace.developmentPort,
		pathname: namespace.pathname,
	});
	const existing = getHubNamespace();
	if (existing) {
		if (
			(Object.keys(value) as (keyof HubNamespace)[]).every(
				(key) => value[key] === existing[key],
			)
		)
			return;
		throw new Error("The host hub namespace is already registered.");
	}
	Object.defineProperty(globalThis, namespaceKey, {
		value,
		writable: false,
		configurable: false,
	});
}
export interface HubDaemonLaunchSpec {
	readonly launcher: string;
	readonly argsPrefix: readonly string[];
}
const launchKey = Symbol.for("@cline/shared/hub-daemon-launch/v1");
type LaunchGlobal = typeof globalThis & {
	[launchKey]?: Readonly<HubDaemonLaunchSpec>;
};
export function getHubDaemonLaunchSpec():
	| Readonly<HubDaemonLaunchSpec>
	| undefined {
	return (globalThis as LaunchGlobal)[launchKey];
}
/** Host-selected self-invocation. No PATH lookup or environment-supplied executable. */
export function registerHubDaemonLaunchSpec(spec: HubDaemonLaunchSpec): void {
	if (
		!spec ||
		typeof spec.launcher !== "string" ||
		!isAbsolute(spec.launcher) ||
		spec.launcher.includes("\0") ||
		!Array.isArray(spec.argsPrefix) ||
		spec.argsPrefix.some((arg) => typeof arg !== "string" || arg.includes("\0"))
	)
		throw new Error(
			"Hub daemon launch requires an absolute executable and an argument vector.",
		);
	const existing = getHubDaemonLaunchSpec();
	if (existing) {
		if (
			existing.launcher === spec.launcher &&
			JSON.stringify(existing.argsPrefix) === JSON.stringify(spec.argsPrefix)
		)
			return;
		throw new Error("The host hub daemon launch is already registered.");
	}
	Object.defineProperty(globalThis, launchKey, {
		value: Object.freeze({
			launcher: spec.launcher,
			argsPrefix: Object.freeze([...spec.argsPrefix]),
		}),
		writable: false,
		configurable: false,
	});
}

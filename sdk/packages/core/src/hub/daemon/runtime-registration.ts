// SPDX-License-Identifier: Apache-2.0
import {
	captureHubPeerIdentity,
	getRequiredHubPeerIdentity,
	type HubPeerIdentity,
} from "@cline/shared";
import type { HubWebSocketServerOptions } from "../server/hub-server-options";

export interface HubDaemonRuntime {
	readonly sessionHost: NonNullable<HubWebSocketServerOptions["sessionHost"]>;
	readonly peerIdentity: Readonly<HubPeerIdentity>;
}
const key = Symbol.for("@cline/core/hub-daemon-runtime/v1");
type RuntimeGlobal = typeof globalThis & { [key]?: Readonly<HubDaemonRuntime> };

/** Trusted executable bootstrap registers before importing daemon-entry.
 * The server owns runtime disposal after startup; optional plugins cannot replace
 * this process-wide binding. Registration is not proof of product policy. */
export function registerHubDaemonRuntime(runtime: HubDaemonRuntime): void {
	if (!runtime?.sessionHost)
		throw new Error("Hub daemon registration requires a session host.");
	const peerIdentity = captureHubPeerIdentity(runtime.peerIdentity);
	const existing = (globalThis as RuntimeGlobal)[key];
	if (existing) {
		if (
			existing.sessionHost === runtime.sessionHost &&
			existing.peerIdentity.applicationId === peerIdentity.applicationId &&
			existing.peerIdentity.policyDigest === peerIdentity.policyDigest
		)
			return;
		throw new Error("Hub daemon runtime is already registered.");
	}
	Object.defineProperty(globalThis, key, {
		value: Object.freeze({ sessionHost: runtime.sessionHost, peerIdentity }),
		writable: false,
		configurable: false,
	});
}

/** Read before constructing listeners, stores or scheduled runtimes. */
export function getHubDaemonRuntime(): Readonly<HubDaemonRuntime> | undefined {
	const expected = getRequiredHubPeerIdentity();
	const runtime = (globalThis as RuntimeGlobal)[key];
	if (expected && !runtime)
		throw new Error(
			"Governed daemon runtime is not registered by trusted host bootstrap.",
		);
	if (
		expected &&
		runtime &&
		(expected.applicationId !== runtime.peerIdentity.applicationId ||
			expected.policyDigest !== runtime.peerIdentity.policyDigest)
	) {
		throw new Error(
			"Hub daemon runtime identity does not match trusted host bootstrap.",
		);
	}
	return runtime;
}

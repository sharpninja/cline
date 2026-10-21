// SPDX-License-Identifier: Apache-2.0
import { getHubNamespace } from "./hub-namespace";

/** Product build family and the host's verified governance policy digest. */
export interface HubPeerIdentity {
	readonly applicationId: string;
	readonly policyDigest: string;
}
const key = Symbol.for("@cline/shared/hub-peer-identity/v1");
type IdentityGlobal = typeof globalThis & { [key]?: Readonly<HubPeerIdentity> };

export function captureHubPeerIdentity(
	value: unknown,
): Readonly<HubPeerIdentity> {
	if (!value || typeof value !== "object")
		throw new Error("Hub peer identity is missing.");
	const { applicationId, policyDigest } = value as HubPeerIdentity;
	if (
		typeof applicationId !== "string" ||
		!/^[a-z][a-z0-9.-]{0,127}$/.test(applicationId) ||
		typeof policyDigest !== "string" ||
		!/^[a-f0-9]{64}$/.test(policyDigest)
	) {
		throw new Error(
			"Hub peer identity requires a product ID and lowercase SHA256 policy digest.",
		);
	}
	return Object.freeze({ applicationId, policyDigest });
}

/** Trusted bootstrap only: register before hub discovery; optional plugins cannot replace it. */
export function registerHubPeerIdentity(value: HubPeerIdentity): void {
	const captured = captureHubPeerIdentity(value);
	const existing = (globalThis as IdentityGlobal)[key];
	if (existing) {
		if (
			existing.applicationId === captured.applicationId &&
			existing.policyDigest === captured.policyDigest
		)
			return;
		throw new Error("The host hub peer identity is already registered.");
	}
	Object.defineProperty(globalThis, key, {
		value: captured,
		writable: false,
		configurable: false,
	});
}

export function getRequiredHubPeerIdentity():
	| Readonly<HubPeerIdentity>
	| undefined {
	const value = (globalThis as IdentityGlobal)[key];
	if (!value && getHubNamespace()?.requirePeerIdentity)
		throw new Error(
			"Hub governance identity is not initialized by trusted host bootstrap.",
		);
	return value;
}

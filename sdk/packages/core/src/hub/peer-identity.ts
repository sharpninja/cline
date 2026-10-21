// SPDX-License-Identifier: Apache-2.0
import {
	captureHubPeerIdentity,
	ensureLoopbackProxyBypass,
	getRequiredHubPeerIdentity,
	type HubPeerIdentity,
} from "@cline/shared";

/** Only this redacted transport result may be interpreted as an absent listener. */
export class HubConnectionRefusedError extends Error {
	constructor() {
		super("Hub listener refused the connection.");
	}
}
function connectionRefused(error: unknown): boolean {
	const candidate = error as {
		code?: string;
		cause?: { code?: string };
	} | null;
	return (
		candidate?.code === "ECONNREFUSED" ||
		candidate?.cause?.code === "ECONNREFUSED"
	);
}
function hubHttpEndpoint(url: string, pathname: string): URL {
	let endpoint: URL;
	try {
		endpoint = new URL(url);
	} catch {
		throw new Error("Unsupported hub identity endpoint.");
	}
	if (
		!["ws:", "wss:", "http:", "https:"].includes(endpoint.protocol) ||
		endpoint.username ||
		endpoint.password
	)
		throw new Error("Unsupported hub identity endpoint.");
	endpoint.protocol =
		endpoint.protocol === "wss:" || endpoint.protocol === "https:"
			? "https:"
			: "http:";
	endpoint.pathname = pathname;
	endpoint.search = "";
	endpoint.hash = "";
	return endpoint;
}

/** No credentials or identity claim: only ECONNREFUSED proves that no listener answered. */
export async function isHubListenerAbsent(url: string): Promise<boolean> {
	const endpoint = hubHttpEndpoint(url, "/health");
	ensureLoopbackProxyBypass();
	try {
		await fetch(endpoint, {
			redirect: "error",
			signal: AbortSignal.timeout(1000),
		});
		return false;
	} catch (error) {
		return connectionRefused(error);
	}
}

/** Return the same authenticated status body used to verify identity. */
export async function readVerifiedHubStatus(
	url: string,
	authToken?: string,
	signal?: AbortSignal,
): Promise<unknown> {
	const expected = getRequiredHubPeerIdentity();
	if (!expected) return;
	if (!authToken?.trim())
		throw new Error(
			"Hub identity verification requires authenticated status access.",
		);
	const endpoint = hubHttpEndpoint(url, "/status");
	ensureLoopbackProxyBypass();
	try {
		const response = await fetch(endpoint, {
			headers: { authorization: `Bearer ${authToken}` },
			redirect: "error",
			signal: signal
				? AbortSignal.any([signal, AbortSignal.timeout(5000)])
				: AbortSignal.timeout(5000),
		});
		if (!response.ok) throw new Error("status refused");
		const body: unknown = await response.json();
		const actual = captureHubPeerIdentity(
			body && typeof body === "object"
				? (body as { peerIdentity?: unknown }).peerIdentity
				: undefined,
		);
		if (
			actual.applicationId !== expected.applicationId ||
			actual.policyDigest !== expected.policyDigest
		)
			throw new Error("identity mismatch");
		return body;
	} catch (error) {
		if (connectionRefused(error)) throw new HubConnectionRefusedError();
		throw new Error(
			"Hub identity verification failed: authenticated product and governance policy must match this host.",
		);
	}
}

/** Refusal messages intentionally omit URL, credentials and response bodies. */
export async function verifyHubPeerIdentity(
	url: string,
	authToken?: string,
	signal?: AbortSignal,
): Promise<void> {
	await readVerifiedHubStatus(url, authToken, signal);
}

/** Explicit server declaration, never inferred from the client's registered expectation. */
export function captureHubServerPeerIdentity(
	value: HubPeerIdentity | undefined,
	hasOwnedSessionHost: boolean,
): Readonly<HubPeerIdentity> | undefined {
	const expected = getRequiredHubPeerIdentity();
	if (!value && !expected) return undefined;
	const actual = captureHubPeerIdentity(value);
	if (!hasOwnedSessionHost)
		throw new Error(
			"A product hub identity requires an explicitly owned session host.",
		);
	if (
		expected &&
		(actual.applicationId !== expected.applicationId ||
			actual.policyDigest !== expected.policyDigest)
	)
		throw new Error("Hub server identity does not match trusted host policy.");
	return actual;
}

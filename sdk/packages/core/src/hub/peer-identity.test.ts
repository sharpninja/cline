// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	expected: undefined as
		| undefined
		| { applicationId: string; policyDigest: string },
}));
vi.mock("@cline/shared", async (importOriginal) => ({
	...(await importOriginal<typeof import("@cline/shared")>()),
	getRequiredHubPeerIdentity: () => state.expected,
}));
vi.mock("@ai-sdk/provider-utils", () => ({
	createProviderDefinedToolFactory: vi.fn(() => vi.fn()),
}));

import { NodeHubClient, requestHubDrain, requestHubShutdown } from "./client";
import { connectToHub } from "./client/connect";
import { retireDiscoveredHub } from "./daemon";
import { probeHubServer } from "./discovery";
import {
	captureHubServerPeerIdentity,
	verifyHubPeerIdentity,
} from "./peer-identity";

const identity = { applicationId: "cline-qb", policyDigest: "a".repeat(64) };
const network = vi.fn<typeof fetch>();
beforeEach(() => {
	state.expected = { ...identity };
	vi.stubGlobal("fetch", network);
	network.mockReset();
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});
const goodResponse = () => Response.json({ peerIdentity: identity });

describe("authenticated hub identity", () => {
	it("leaves generic SDK probes optional", async () => {
		state.expected = undefined;
		await verifyHubPeerIdentity("ws://example.test/hub");
		expect(network).not.toHaveBeenCalled();
		expect(captureHubServerPeerIdentity(undefined, false)).toBeUndefined();
	});
	it("uses authenticated status without URL secrets or redirects", async () => {
		network.mockResolvedValue(goodResponse());
		await verifyHubPeerIdentity(
			"wss://example.test/hub?authToken=query-secret#fragment",
			"private-token",
		);
		expect(network).toHaveBeenCalledOnce();
		expect(String(network.mock.calls[0][0])).toBe(
			"https://example.test/status",
		);
		expect(network.mock.calls[0][1]).toMatchObject({
			headers: { authorization: "Bearer private-token" },
			redirect: "error",
		});
	});
	it("refuses unauthenticated status before network", async () => {
		await expect(
			verifyHubPeerIdentity("ws://example.test/hub"),
		).rejects.toThrow(/authenticated/);
		expect(network).not.toHaveBeenCalled();
	});
	it.each([
		{},
		{ peerIdentity: { ...identity, applicationId: "cline" } },
		{ peerIdentity: { ...identity, policyDigest: "b".repeat(64) } },
		{ peerIdentity: { ...identity, policyDigest: "bad" } },
		null,
	])("refuses absent, foreign and malformed identity: %j", async (body) => {
		network.mockResolvedValue(Response.json(body));
		await expect(
			verifyHubPeerIdentity("ws://example.test/hub", "token"),
		).rejects.toThrow(/must match/);
	});
	it.each([401, 403, 404, 500])("refuses status %i", async (status) => {
		network.mockResolvedValue(new Response("private response", { status }));
		await expect(
			verifyHubPeerIdentity("ws://example.test/hub", "token"),
		).rejects.toThrow(/verification failed/);
	});
	it("redacts transport failures", async () => {
		network.mockRejectedValue(new Error("private-token and remote body"));
		await expect(
			verifyHubPeerIdentity("ws://example.test/hub", "private-token"),
		).rejects.toThrow(
			/^Hub identity verification failed: authenticated product and governance policy must match this host\.$/,
		);
	});
	it("requires an explicit server declaration and host", () => {
		expect(() => captureHubServerPeerIdentity(undefined, true)).toThrow(
			/missing/,
		);
		expect(() => captureHubServerPeerIdentity(identity, false)).toThrow(
			/owned session host/,
		);
		expect(() =>
			captureHubServerPeerIdentity(
				{ ...identity, applicationId: "cline" },
				true,
			),
		).toThrow(/does not match/);
		const declaration = { ...identity };
		const captured = captureHubServerPeerIdentity(declaration, true);
		declaration.policyDigest = "b".repeat(64);
		expect(captured).toEqual(identity);
		expect(Object.isFrozen(captured)).toBe(true);
	});
	it("does not treat failed identity as a reusable discovery result", async () => {
		network.mockResolvedValue(
			Response.json({
				protocolVersion: "v1",
				host: "localhost",
				port: 1,
				url: "ws://localhost:1/hub",
			}),
		);
		await expect(
			probeHubServer("ws://localhost:1/hub", { authToken: "token" }),
		).rejects.toThrow(/must match/);
	});
	it.each([
		"short",
		"persistent",
	])("refuses %s client before WebSocket construction", async (kind) => {
		network.mockResolvedValue(Response.json({}));
		const Socket = vi.fn();
		vi.stubGlobal("WebSocket", Socket);
		const client = new NodeHubClient({
			url: "ws://example.test/hub",
			authToken: "token",
		});
		try {
			await expect(
				kind === "short"
					? connectToHub("ws://example.test/hub?authToken=token")
					: client.connect(),
			).rejects.toThrow(/must match/);
			expect(Socket).not.toHaveBeenCalled();
		} finally {
			client.close();
		}
	});
	it.each([
		"drain",
		"shutdown",
		"retire",
	])("refuses %s without changing the foreign daemon", async (operation) => {
		network.mockResolvedValue(Response.json({}));
		const kill = vi.spyOn(process, "kill").mockReturnValue(true);
		const attempt =
			operation === "drain"
				? requestHubDrain("ws://example.test/hub", "token")
				: operation === "shutdown"
					? requestHubShutdown("ws://example.test/hub", "token")
					: retireDiscoveredHub(
							{ url: "ws://example.test/hub", authToken: "token", pid: 12345 },
							"/tmp/unused-discovery",
						);
		await expect(attempt).rejects.toThrow(/must match/);
		expect(network).toHaveBeenCalledOnce();
		expect(network.mock.calls[0][1]?.method).toBeUndefined();
		expect(kill).not.toHaveBeenCalled();
	});
	it("checks again before a control request", async () => {
		network
			.mockResolvedValueOnce(goodResponse())
			.mockResolvedValueOnce(new Response("ok"));
		expect(await requestHubDrain("ws://example.test/hub", "token")).toBe(true);
		expect(String(network.mock.calls[0][0])).toBe("http://example.test/status");
		expect(network.mock.calls[1][1]).toMatchObject({
			method: "POST",
			redirect: "error",
		});
	});
});
it("does not open a socket after close during identity verification", async () => {
	let release!: (value: Response) => void;
	network.mockImplementation(
		() =>
			new Promise<Response>((resolve) => {
				release = resolve;
			}),
	);
	const Socket = vi.fn();
	vi.stubGlobal("WebSocket", Socket);
	const client = new NodeHubClient({
		url: "ws://example.test/hub",
		authToken: "token",
	});
	const pending = client.connect();
	const checked = expect(pending).rejects.toThrow();
	client.close();
	release(goodResponse());
	await checked;
	expect(Socket).not.toHaveBeenCalled();
});

it("checks fresh identity when reconnecting after a failed attempt", async () => {
	network.mockResolvedValue(Response.json({}));
	const client = new NodeHubClient({
		url: "ws://example.test/hub",
		authToken: "token",
	});
	try {
		await expect(client.connect()).rejects.toThrow(/must match/);
		network.mockResolvedValue(
			Response.json({ peerIdentity: { ...identity, applicationId: "other" } }),
		);
		await expect(client.connect()).rejects.toThrow(/must match/);
		expect(network).toHaveBeenCalledTimes(2);
	} finally {
		client.close();
	}
});

it("does not follow a real HTTP redirect to a different service", async () => {
	vi.unstubAllGlobals();
	const { createServer } = await import("node:http");
	let redirected = 0;
	const server = createServer((req, res) => {
		if (req.url === "/status") {
			res.writeHead(302, { location: "/foreign" });
			res.end();
		} else {
			redirected++;
			res.end(JSON.stringify({ peerIdentity: identity }));
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("No listener");
	try {
		await expect(
			verifyHubPeerIdentity(`ws://127.0.0.1:${address.port}/hub`, "token"),
		).rejects.toThrow(/must match/);
		expect(redirected).toBe(0);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
it("does not call an identity refusal retired or signal its PID", async () => {
	const { mkdtemp, writeFile, readFile, rm } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const root = await mkdtemp(join(tmpdir(), "qb-retire-"));
	const discovery = join(root, "discovery.json");
	await writeFile(discovery, "retained record");
	network.mockImplementation(async (url, options) => {
		if (String(url).endsWith("/status")) return goodResponse();
		if (options?.method === "POST")
			return new Response("refused", { status: 403 });
		return new Response("alive", { status: 401 });
	});
	const kill = vi.spyOn(process, "kill").mockReturnValue(true);
	try {
		expect(
			await retireDiscoveredHub(
				{ url: "ws://example.test:21990/hub", authToken: "token", pid: 12345 },
				discovery,
			),
		).toBe(false);
		expect(await readFile(discovery, "utf8")).toBe("retained record");
		expect(kill).not.toHaveBeenCalled();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}, 10000);

it("clears retirement discovery only after connection refusal", async () => {
	const { mkdtemp, writeFile, access, rm } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const root = await mkdtemp(join(tmpdir(), "qb-retired-"));
	const discovery = join(root, "discovery.json");
	await writeFile(
		discovery,
		JSON.stringify(
			discoveryRecord("old", "ws://example.test:21991/hub", "token"),
		),
	);
	network.mockImplementation(async (url, options) => {
		if (String(url).endsWith("/status")) return goodResponse();
		if (options?.method === "POST") return new Response("ok");
		throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
	});
	const kill = vi.spyOn(process, "kill").mockReturnValue(true);
	try {
		expect(
			await retireDiscoveredHub(
				{ url: "ws://example.test:21991/hub", authToken: "token", pid: 12345 },
				discovery,
			),
		).toBe(true);
		await expect(access(discovery)).rejects.toThrow();
		expect(kill).not.toHaveBeenCalled();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it("redacts malformed endpoint input before any network access", async () => {
	await expect(
		verifyHubPeerIdentity("private-token is not a URL", "token"),
	).rejects.toThrow(/^Unsupported hub identity endpoint\.$/);
	expect(network).not.toHaveBeenCalled();
});

it.each([
	"replaced-during-retire",
	"different-at-start",
	"unreadable",
])("preserves discovery without ownership proof: %s", async (scenario) => {
	const { mkdtemp, writeFile, readFile, rm } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const root = await mkdtemp(join(tmpdir(), "qb-retire-race-"));
	const path = join(root, "discovery.json");
	const url = `ws://example.test:${scenario === "replaced-during-retire" ? 21992 : scenario === "different-at-start" ? 21993 : 21994}/hub`;
	const old = JSON.stringify(discoveryRecord("old", url, "token"));
	const next = JSON.stringify(discoveryRecord("new", url, "new-token"));
	const initial =
		scenario === "different-at-start"
			? next
			: scenario === "unreadable"
				? "unreadable evidence"
				: old;
	await writeFile(path, initial);
	network.mockImplementation(async (endpoint, options) => {
		if (String(endpoint).endsWith("/status")) return goodResponse();
		if (options?.method === "POST") {
			if (scenario === "replaced-during-retire") await writeFile(path, next);
			return new Response("ok");
		}
		throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
	});
	try {
		expect(await retireDiscoveredHub({ url, authToken: "token" }, path)).toBe(
			true,
		);
		expect(await readFile(path, "utf8")).toBe(
			scenario === "replaced-during-retire" ? next : initial,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
function discoveryRecord(hubId: string, url: string, authToken: string) {
	return {
		hubId,
		url,
		authToken,
		protocolVersion: "v1",
		host: "example.test",
		port: Number(new URL(url).port),
		startedAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
	};
}

it.each([
	"node",
	"bun",
	"timeout",
])("classifies %s transport without exposing its details", async (kind) => {
	const { HubConnectionRefusedError } = await import("./peer-identity");
	const error =
		kind === "node"
			? new TypeError("private token", { cause: { code: "ECONNREFUSED" } })
			: kind === "bun"
				? Object.assign(new Error("private token"), { code: "ECONNREFUSED" })
				: new DOMException("private token", "TimeoutError");
	network.mockRejectedValue(error);
	const result = await verifyHubPeerIdentity(
		"ws://127.0.0.1:25473/hub",
		"private-token",
	).then(
		() => null,
		(error) => error,
	);
	expect(result).toBeInstanceOf(Error);
	expect(result instanceof HubConnectionRefusedError).toBe(kind !== "timeout");
	expect(String(result)).not.toContain("private");
	expect(result.cause).toBeUndefined();
});

it("observes real listener closure without confusing HTTP refusal", async () => {
	vi.unstubAllGlobals();
	const { createServer } = await import("node:http");
	const { isHubListenerAbsent, HubConnectionRefusedError } = await import(
		"./peer-identity"
	);
	let requests = 0;
	const server = createServer((_req, res) => {
		requests++;
		res.writeHead(401);
		res.end("private body");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("No listener");
	const url = `ws://127.0.0.1:${address.port}/hub`;
	try {
		expect(await isHubListenerAbsent(url)).toBe(false);
		await expect(
			probeHubServer(url, { authToken: "synthetic-token" }),
		).rejects.toThrow(/must match/);
		expect(requests).toBe(2);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
	// A pooled connection may first reset after listener closure; only a later
	// refused connection proves absence, just as the retirement loop requires.
	await expect
		.poll(() => isHubListenerAbsent(url), { timeout: 2000, interval: 50 })
		.toBe(true);
	await expect(
		probeHubServer(url, { authToken: "synthetic-token" }),
	).rejects.toBeInstanceOf(HubConnectionRefusedError);
});

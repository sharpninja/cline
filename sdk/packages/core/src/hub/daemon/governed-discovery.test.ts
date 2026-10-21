// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	root: "",
	spawn: vi.fn(),
	connect: vi.fn(async () => true),
	drain: vi.fn(),
	shutdown: vi.fn(),
}));
const identity = { applicationId: "cline-qb", policyDigest: "a".repeat(64) };
const url = "ws://127.0.0.1:25473/hub";
vi.mock("node:child_process", async (original) => ({
	...(await original<typeof import("node:child_process")>()),
	spawn: state.spawn,
}));
vi.mock("@cline/shared", async (original) => ({
	...(await original<typeof import("@cline/shared")>()),
	getRequiredHubPeerIdentity: () => ({
		applicationId: "cline-qb",
		policyDigest: "a".repeat(64),
	}),
	getHubNamespace: () => ({
		requirePeerIdentity: true,
		hostVariable: "QB_TEST_HOST",
		portVariable: "QB_TEST_PORT",
		discoveryVariable: "QB_TEST_DISCOVERY",
		defaultHost: "127.0.0.1",
		productionPort: 25473,
		developmentPort: 25473,
		pathname: "/hub",
	}),
	getHubDaemonLaunchSpec: () => ({
		launcher: process.execPath,
		argsPrefix: [],
	}),
	resolveClineBuildEnv: () => "production",
	isHubDaemonProcess: () => false,
}));
vi.mock("../discovery/workspace", () => ({
	resolveProductionHubOwnerContext: () => ({
		discoveryPath: join(state.root, "discovery.json"),
	}),
	resolveSharedHubOwnerContext: () => ({
		discoveryPath: join(state.root, "legacy.json"),
	}),
}));
vi.mock("../discovery", async (original) => ({
	...(await original<typeof import("../discovery")>()),
	resolveClineDataDir: () => state.root,
	isManagedHubReusable: () => true,
}));
vi.mock("../client", async (original) => ({
	...(await original<typeof import("../client")>()),
	verifyHubConnection: state.connect,
	requestHubDrain: state.drain,
	requestHubShutdown: state.shutdown,
}));

import { ensureDetachedHubServer, upgradeManagedHub } from ".";

const network = vi.fn<typeof fetch>();
const discovery = () => join(state.root, "discovery.json");
const refused = () =>
	new TypeError("private transport detail", {
		cause: { code: "ECONNREFUSED" },
	});
function record(hubId = "old") {
	return {
		hubId,
		protocolVersion: "v1",
		host: "127.0.0.1",
		port: 25473,
		url,
		authToken: "synthetic-token",
		startedAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
	};
}
function publish(hubId = "old") {
	const bytes = JSON.stringify(record(hubId));
	writeFileSync(discovery(), bytes);
	return bytes;
}
beforeEach(() => {
	state.root = mkdtempSync(join(tmpdir(), "qb-discovery-trust-"));
	network.mockReset();
	state.spawn.mockReset();
	state.connect.mockClear();
	state.drain.mockClear();
	state.shutdown.mockClear();
	state.spawn.mockImplementation(() => ({ unref: vi.fn() }));
	vi.stubGlobal("fetch", network);
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	rmSync(state.root, { recursive: true, force: true });
});

it.each([
	"foreign",
	"policy",
	"401",
	"500",
	"malformed",
	"wrong-url",
	"timeout",
])("preserves discovery and refuses startup after %s", async (kind) => {
	const before = publish();
	network.mockImplementation(async () => {
		if (kind === "timeout")
			throw new DOMException("private-token", "TimeoutError");
		if (kind === "401" || kind === "500")
			return new Response("private response", { status: Number(kind) });
		const payload: Record<string, unknown> = {
			...record(),
			peerIdentity: identity,
		};
		if (kind === "foreign")
			payload.peerIdentity = { ...identity, applicationId: "cline" };
		if (kind === "policy")
			payload.peerIdentity = { ...identity, policyDigest: "b".repeat(64) };
		if (kind === "malformed") payload.port = "wrong";
		if (kind === "wrong-url") payload.url = "ws://foreign.test/hub";
		return Response.json(payload);
	});
	await expect(ensureDetachedHubServer(state.root)).rejects.toThrow(
		/^Governed hub discovery refused:/,
	);
	expect(readFileSync(discovery(), "utf8")).toBe(before);
	expect(state.spawn).not.toHaveBeenCalled();
	expect(state.connect).not.toHaveBeenCalled();
	expect(state.drain).not.toHaveBeenCalled();
	expect(state.shutdown).not.toHaveBeenCalled();
	expect(network).toHaveBeenCalledOnce();
});
it("upgrade also preserves identity refusal instead of starting a replacement", async () => {
	const before = publish();
	network.mockResolvedValue(Response.json({}));
	await expect(
		upgradeManagedHub({ workspaceRoot: state.root }),
	).rejects.toThrow(/discovery refused/);
	expect(readFileSync(discovery(), "utf8")).toBe(before);
	expect(state.spawn).not.toHaveBeenCalled();
});
it("reuses one verified response and the original discovery credential", async () => {
	publish();
	network.mockResolvedValue(
		Response.json({
			...record(),
			authToken: "response-substitution",
			peerIdentity: identity,
		}),
	);
	expect(await ensureDetachedHubServer(state.root)).toEqual({
		url,
		authToken: "synthetic-token",
	});
	expect(network).toHaveBeenCalledOnce();
	expect(state.spawn).not.toHaveBeenCalled();
	expect(state.connect).toHaveBeenCalledWith(url, {
		authToken: "synthetic-token",
	});
});
it.each([
	"live",
	"timeout",
	"dns",
	"redirect",
])("refuses an undiscovered %s endpoint without spawning", async (kind) => {
	network.mockImplementation(async () => {
		if (kind === "timeout") throw new DOMException("private", "TimeoutError");
		if (kind === "dns")
			throw new TypeError("private", { cause: { code: "ENOTFOUND" } });
		if (kind === "redirect") throw new TypeError("unexpected redirect");
		return new Response("occupied", { status: 401 });
	});
	await expect(
		ensureDetachedHubServer(state.root, { allowPortFallback: true }),
	).rejects.toThrow(/occupied or unavailable/);
	expect(state.spawn).not.toHaveBeenCalled();
	expect(state.connect).not.toHaveBeenCalled();
	expect(network).toHaveBeenCalledOnce();
	expect(network.mock.calls[0][1]?.headers).toBeUndefined();
});
it("starts on connection refusal and waits for authenticated discovery publication", async () => {
	let launched = false;
	network.mockImplementation(async (endpoint) => {
		if (String(endpoint).endsWith("/health")) {
			if (!launched) throw refused();
			return new Response("listening");
		}
		return Response.json({ ...record("new"), peerIdentity: identity });
	});
	state.spawn.mockImplementation(() => {
		launched = true;
		setTimeout(() => publish("new"), 30);
		return { unref: vi.fn() };
	});
	expect(
		await ensureDetachedHubServer(state.root, { allowPortFallback: true }),
	).toEqual({ url, authToken: "synthetic-token" });
	expect(state.spawn).toHaveBeenCalledOnce();
	expect(state.spawn.mock.calls[0][1]).toContain("25473");
	expect(state.spawn.mock.calls[0][1]).not.toContain("0");
	expect(
		network.mock.calls.filter(([endpoint]) =>
			String(endpoint).endsWith("/status"),
		),
	).toHaveLength(1);
});
it("only removes the observed generation after connection refusal", async () => {
	publish();
	let launched = false;
	network.mockImplementation(async () => {
		if (!launched) throw refused();
		return Response.json({ ...record("new"), peerIdentity: identity });
	});
	state.spawn.mockImplementation(() => {
		launched = true;
		publish("new");
		return { unref: vi.fn() };
	});
	expect(await ensureDetachedHubServer(state.root)).toEqual({
		url,
		authToken: "synthetic-token",
	});
	expect(JSON.parse(readFileSync(discovery(), "utf8")).hubId).toBe("new");
	expect(state.spawn).toHaveBeenCalledOnce();
});
it("preserves a successor installed during the refusal check", async () => {
	publish();
	network.mockImplementation(async () => {
		publish("successor");
		throw refused();
	});
	await expect(ensureDetachedHubServer(state.root)).rejects.toThrow(
		/discovery changed/,
	);
	expect(JSON.parse(readFileSync(discovery(), "utf8")).hubId).toBe("successor");
	expect(state.spawn).not.toHaveBeenCalled();
});
it("refuses a foreign discovery published during child startup", async () => {
	network.mockImplementation(async (endpoint) => {
		if (String(endpoint).endsWith("/health")) throw refused();
		return Response.json({
			...record("foreign"),
			peerIdentity: { ...identity, applicationId: "cline" },
		});
	});
	state.spawn.mockImplementation(() => {
		publish("foreign");
		return { unref: vi.fn() };
	});
	await expect(ensureDetachedHubServer(state.root)).rejects.toThrow(
		/discovery refused/,
	);
	expect(JSON.parse(readFileSync(discovery(), "utf8")).hubId).toBe("foreign");
	expect(state.connect).not.toHaveBeenCalled();
	expect(state.drain).not.toHaveBeenCalled();
	expect(state.shutdown).not.toHaveBeenCalled();
});

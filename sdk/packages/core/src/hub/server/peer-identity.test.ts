// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

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

import { verifyHubPeerIdentity } from "../peer-identity";
import {
	ensureHubWebSocketServer,
	startHubWebSocketServer,
} from "./hub-websocket-server";

it("publishes only the explicit host identity on authenticated status", async () => {
	const root = await mkdtemp(join(tmpdir(), "qb-peer-server-"));
	const identity = { applicationId: "cline-qb", policyDigest: "a".repeat(64) };
	state.expected = { ...identity };
	const sessionHost = {
		subscribe: vi.fn(() => () => {}),
		startSession: vi.fn(),
		runTurn: vi.fn(),
		stopSession: vi.fn(async () => {}),
		abort: vi.fn(async () => {}),
		dispose: vi.fn(async () => {}),
		getSession: vi.fn(async () => undefined),
		getAccumulatedUsage: vi.fn(async () => undefined),
		listSessions: vi.fn(async () => []),
		deleteSession: vi.fn(async () => false),
		updateSession: vi.fn(async () => ({ updated: false })),
		updateSessionCompactionState: vi.fn(async () => ({ updated: false })),
		readSessionCompactionState: vi.fn(async () => undefined),
		readSessionMessages: vi.fn(async () => []),
		dispatchHookEvent: vi.fn(async () => {}),
		restoreSession: vi.fn(),
	};
	const options = {
		owner: {
			ownerId: "peer-test",
			discoveryPath: join(root, "discovery.json"),
		},
		host: "127.0.0.1",
		port: 0,
		workspaceRoot: root,
		runtimeHandlers: {
			startSession: vi.fn(),
			sendSession: vi.fn(),
			abortSession: vi.fn(),
			stopSession: vi.fn(),
		},
		scheduleOptions: { dbPath: ":memory:" },
		taskOptions: {
			dbPath: join(root, "tasks.db"),
			globalSpecsDir: join(root, "specs"),
			watchFiles: false,
		},
		eventLog: false as const,
		runQueue: false as const,
		sessionHost,
	};
	let server: Awaited<ReturnType<typeof startHubWebSocketServer>> | undefined;
	try {
		await expect(startHubWebSocketServer(options as never)).rejects.toThrow(
			/missing/,
		);
		server = await startHubWebSocketServer({
			...options,
			peerIdentity: identity,
		} as never);
		identity.policyDigest = "b".repeat(64);
		const base = `http://127.0.0.1:${server.port}`;
		expect((await fetch(`${base}/status`)).status).toBe(401);
		const status = await (
			await fetch(`${base}/status`, {
				headers: { authorization: `Bearer ${server.authToken}` },
			})
		).json();
		expect(status).toMatchObject({ peerIdentity: state.expected });
		expect(await (await fetch(`${base}/health`)).json()).not.toHaveProperty(
			"peerIdentity",
		);
		await verifyHubPeerIdentity(server.url, server.authToken);
		state.expected = {
			applicationId: "different",
			policyDigest: "a".repeat(64),
		};
		await expect(
			ensureHubWebSocketServer({ ...options, port: server.port } as never),
		).rejects.toThrow(/must match/);
		expect(
			(
				await fetch(`${base}/status`, {
					headers: { authorization: `Bearer ${server.authToken}` },
				})
			).status,
		).toBe(200);
	} finally {
		await server?.close();
		state.expected = undefined;
		await rm(root, { recursive: true, force: true });
	}
}, 20000);

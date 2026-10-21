// SPDX-License-Identifier: Apache-2.0

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerHubNamespace } from "@cline/shared";
import { registerStorageNamespace } from "@cline/shared/storage";
import { expect, it, vi } from "vitest";

vi.mock("@ai-sdk/provider-utils", () => ({
	createProviderDefinedToolFactory: vi.fn(() => vi.fn()),
}));

import { ensureHubWebSocketServer } from "./hub-websocket-server";

it("keeps an occupied private port untouched and refuses automatic fallback", async () => {
	const root = mkdtempSync(join(tmpdir(), "qb-hub-port-"));
	registerStorageNamespace({
		resolvePath: () => root,
		globalRulesPaths: () => [],
		validatePath: (path) => path,
	});
	registerHubNamespace({
		hostVariable: "PRIVATE_HOST",
		portVariable: "PRIVATE_PORT",
		discoveryVariable: "PRIVATE_DISCOVERY",
		defaultHost: "127.0.0.1",
		productionPort: 25473,
		developmentPort: 25476,
		pathname: "/hub",
	});
	const occupant = createServer((_req, res) => res.end("existing service"));
	await new Promise<void>((resolve) =>
		occupant.listen(0, "127.0.0.1", resolve),
	);
	const address = occupant.address();
	if (!address || typeof address === "string")
		throw new Error("No occupied port");
	const discoveryPath = join(root, "discovery.json");
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
	try {
		const attempt = ensureHubWebSocketServer({
			owner: { ownerId: "private-occupied-port", discoveryPath },
			host: "127.0.0.1",
			port: address.port,
			pathname: "/hub",
			workspaceRoot: root,
			allowPortFallback: true,
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
			eventLog: { dbPath: ":memory:" },
			runQueue: { dbPath: ":memory:" },
			sessionHost,
		} as never);
		// Close an unexpected fallback server before asserting so a regression cannot leak it.
		const outcome = await attempt.then(
			async (result) => {
				await result.server?.close();
				return undefined;
			},
			(error) => error,
		);
		expect(outcome).toMatchObject({ code: "EADDRINUSE" });
		expect(occupant.listening).toBe(true);
		expect(existsSync(discoveryPath)).toBe(false);
		expect(await (await fetch("http://127.0.0.1:" + address.port)).text()).toBe(
			"existing service",
		);
	} finally {
		await new Promise<void>((resolve, reject) =>
			occupant.close((error) => (error ? reject(error) : resolve())),
		);
		rmSync(root, { recursive: true, force: true });
	}
}, 20000);

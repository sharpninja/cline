// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	read: vi.fn(),
	retire: vi.fn(),
	spawn: vi.fn(),
	clear: vi.fn(),
	connectors: vi.fn(),
	stop: vi.fn(),
}));
vi.mock("@cline/shared", async (original) => ({
	...(await original<typeof import("@cline/shared")>()),
	getHubNamespace: () => ({ requirePeerIdentity: true }),
}));
vi.mock("node:child_process", () => ({ spawnSync: mocks.spawn }));
vi.mock("@cline/core", () => ({
	readHubDiscovery: mocks.read,
	readSupersededHubDiscovery: vi.fn(),
	retireDiscoveredHub: mocks.retire,
	resolveClineDataDir: () => "/tmp/qb-doctor-unread-root",
	probeHubServer: vi.fn(),
	clearHubDiscovery: mocks.clear,
	stopLocalHubServerGracefully: mocks.stop,
	ensureFileExists: vi.fn(),
	listActiveConnectors: () => [],
	resolveProductionHubOwnerContext: () => ({
		discoveryPath: "/tmp/qb-doctor-owned",
	}),
	resolveSharedHubOwnerContext: () => ({
		discoveryPath: "/tmp/qb-doctor-owned",
	}),
}));
vi.mock("../connectors/common", () => ({ isProcessRunning: () => false }));
vi.mock("./connect", () => ({ stopAllConnectors: mocks.connectors }));
vi.mock("./connect-via-hub", () => ({
	listSupervisedConnectorsViaHub: async () => [],
}));

import { runDoctorCommand } from "./doctor";

const record = {
	hubId: "owned",
	url: "ws://127.0.0.1:25473/hub",
	authToken: "test",
	pid: 12345,
};
beforeEach(() => {
	vi.resetAllMocks();
	mocks.read.mockResolvedValue(record);
	mocks.retire.mockResolvedValue(true);
	mocks.spawn.mockReturnValue({ status: 1, stdout: "" });
	mocks.connectors.mockResolvedValue({
		stoppedProcesses: 0,
		stoppedSessions: 0,
	});
	vi.spyOn(process, "kill").mockReturnValue(true);
});
afterEach(() => vi.restoreAllMocks());
it.each([
	"confirmed",
	"refused",
	"trust-error",
	"absent",
])("governed doctor repair uses only authenticated retirement: %s", async (scenario) => {
	if (scenario === "refused") mocks.retire.mockResolvedValue(false);
	if (scenario === "trust-error")
		mocks.retire.mockRejectedValue(new Error("synthetic-private-detail"));
	if (scenario === "absent") mocks.read.mockResolvedValue(undefined);
	const output: string[] = [],
		errors: string[] = [];
	const code = await runDoctorCommand(
		{ cwd: "/workspace", json: true, fix: true },
		{ writeln: (t) => output.push(t ?? ""), writeErr: (t) => errors.push(t) },
	);
	expect(code).toBe(
		scenario === "refused" || scenario === "trust-error" ? 1 : 0,
	);
	if (scenario === "absent") expect(mocks.retire).not.toHaveBeenCalled();
	else
		expect(mocks.retire).toHaveBeenCalledWith(record, "/tmp/qb-doctor-owned");
	expect(process.kill).not.toHaveBeenCalled();
	expect(mocks.clear).not.toHaveBeenCalled();
	expect(mocks.spawn).not.toHaveBeenCalled();
	expect(mocks.connectors).not.toHaveBeenCalled();
	expect(output.join("\n") + errors.join("\n")).not.toContain(
		"synthetic-private-detail",
	);
	const result = JSON.parse(output[0]);
	expect(result.stopped).toBe(scenario === "confirmed");
	expect(result.repair).toBe("authenticated-hub-retirement");
});

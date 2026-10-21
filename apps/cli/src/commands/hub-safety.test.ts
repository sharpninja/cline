// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	read: vi.fn(),
	retire: vi.fn(),
	drain: vi.fn(),
	idle: vi.fn(),
	ensure: vi.fn(),
	clear: vi.fn(),
	graceful: vi.fn(),
}));
vi.mock("@cline/core", () => ({
	readHubDiscovery: mocks.read,
	retireDiscoveredHub: mocks.retire,
	requestHubDrain: mocks.drain,
	localHubHasNoActiveSessions: mocks.idle,
	ensureDetachedHubServer: mocks.ensure,
	clearHubDiscovery: mocks.clear,
	stopLocalHubServerGracefully: mocks.graceful,
	probeHubServer: vi.fn(),
	resolveProductionHubOwnerContext: () => ({
		discoveryPath: "/tmp/qb-command-discovery",
	}),
	resolveSharedHubOwnerContext: () => ({
		discoveryPath: "/tmp/qb-command-discovery",
	}),
}));

import { createHubCommand } from "./hub";

const record = {
	hubId: "old",
	url: "ws://127.0.0.1:25473/hub",
	authToken: "test",
	pid: 12345,
};
let kill: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
	vi.resetAllMocks();
	mocks.read.mockResolvedValue(record);
	mocks.retire.mockResolvedValue(true);
	mocks.drain.mockResolvedValue(true);
	mocks.idle.mockResolvedValue(true);
	mocks.graceful.mockResolvedValue(false);
	mocks.ensure.mockResolvedValue({ url: record.url });
	kill = vi.spyOn(process, "kill").mockReturnValue(true);
});
afterEach(() => vi.restoreAllMocks());
async function run(args: string[]) {
	const output: string[] = [],
		errors: string[] = [];
	let code = 0;
	await createHubCommand(
		{
			writeln: (text) => output.push(text ?? ""),
			writeErr: (text) => errors.push(text),
		},
		(value) => {
			code = value;
		},
	).parseAsync(args, { from: "user" });
	return { output, errors, code };
}
it("uses authenticated retirement for stop and never signals discovery PIDs", async () => {
	const result = await run(["stop"]);
	expect(result.code).toBe(0);
	expect(mocks.retire).toHaveBeenCalledWith(
		record,
		"/tmp/qb-command-discovery",
	);
	expect(kill).not.toHaveBeenCalled();
	expect(mocks.clear).not.toHaveBeenCalled();
});
it.each([
	"refused",
	"unavailable",
])("reports failed retirement (%s) without losing discovery", async (failure) => {
	if (failure === "refused") mocks.retire.mockResolvedValue(false);
	else mocks.retire.mockRejectedValue(new Error("identity unavailable"));
	const result = await run(["stop"]);
	expect(result.code).toBe(1);
	expect(result.errors.length).toBeGreaterThan(0);
	expect(kill).not.toHaveBeenCalled();
	expect(mocks.clear).not.toHaveBeenCalled();
});
it("reports an absent hub without treating a stale PID as authority", async () => {
	mocks.read.mockResolvedValue({ pid: 12345 });
	const result = await run(["stop"]);
	expect(result.code).toBe(0);
	expect(JSON.parse(result.output[0])).toEqual({ stopped: false });
	expect(mocks.retire).not.toHaveBeenCalled();
	expect(kill).not.toHaveBeenCalled();
	expect(mocks.clear).not.toHaveBeenCalled();
});
it.each([
	"refused",
	"error",
])("requires accepted drain before upgrade (%s)", async (failure) => {
	if (failure === "refused") mocks.drain.mockResolvedValue(false);
	else mocks.drain.mockRejectedValue(new Error("identity mismatch"));
	const result = await run(["upgrade", "--wait", "0"]);
	expect(result.code).toBe(1);
	expect(mocks.idle).not.toHaveBeenCalled();
	expect(mocks.retire).not.toHaveBeenCalled();
	expect(mocks.ensure).not.toHaveBeenCalled();
	expect(kill).not.toHaveBeenCalled();
});
it("treats failed activity observation as unknown and releases its drain", async () => {
	mocks.idle.mockRejectedValue(new Error("query failed"));
	const result = await run(["upgrade", "--wait", "0"]);
	expect(result.code).toBe(1);
	expect(mocks.retire).not.toHaveBeenCalled();
	expect(mocks.ensure).not.toHaveBeenCalled();
	expect(mocks.drain).toHaveBeenLastCalledWith(
		record.url,
		record.authToken,
		"cline hub upgrade aborted",
		{ off: true },
	);
});
it("does not launch replacement until retirement is confirmed", async () => {
	mocks.retire.mockResolvedValue(false);
	const result = await run(["upgrade", "--wait", "0"]);
	expect(result.code).toBe(1);
	expect(mocks.ensure).not.toHaveBeenCalled();
	expect(mocks.drain).toHaveBeenLastCalledWith(
		record.url,
		record.authToken,
		"cline hub upgrade aborted",
		{ off: true },
	);
});
it("retires the observed generation even when discovery changes during idle check", async () => {
	mocks.idle.mockImplementation(async () => {
		mocks.read.mockResolvedValue({
			...record,
			hubId: "new",
			authToken: "new-token",
		});
		return true;
	});
	const result = await run(["upgrade", "--wait", "0"]);
	expect(result.code).toBe(0);
	expect(mocks.retire).toHaveBeenCalledWith(
		record,
		"/tmp/qb-command-discovery",
	);
	expect(mocks.ensure.mock.invocationCallOrder[0]).toBeGreaterThan(
		mocks.retire.mock.invocationCallOrder[0],
	);
});

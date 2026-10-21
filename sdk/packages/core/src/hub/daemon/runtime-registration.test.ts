// SPDX-License-Identifier: Apache-2.0
import { expect, it, vi } from "vitest";
const expected = vi.hoisted(() =>
	vi.fn(
		(): { applicationId: string; policyDigest: string } | undefined =>
			undefined,
	),
);
vi.mock("@cline/shared", async (original) => ({
	...(await original<typeof import("@cline/shared")>()),
	getRequiredHubPeerIdentity: expected,
}));
import {
	getHubDaemonRuntime,
	registerHubDaemonRuntime,
	type HubDaemonRuntime,
} from "./runtime-registration";

it("AC002/013 daemon binding survives module reload, rejects replacement and mismatched identity, and preserves generic SDK defaults", async () => {
	expect(getHubDaemonRuntime()).toBeUndefined();
	const identity = { applicationId: "cline-qb", policyDigest: "a".repeat(64) };
	expected.mockReturnValue(identity);
	expect(() => getHubDaemonRuntime()).toThrow("not registered");
	expect(() =>
		registerHubDaemonRuntime({ peerIdentity: identity } as HubDaemonRuntime),
	).toThrow("requires a session host");
	const sessionHost = {} as HubDaemonRuntime["sessionHost"];
	expect(() =>
		registerHubDaemonRuntime({
			sessionHost,
			peerIdentity: { ...identity, policyDigest: "invalid" },
		}),
	).toThrow("SHA256");
	const input = { sessionHost, peerIdentity: { ...identity } };
	registerHubDaemonRuntime(input);
	const runtime = getHubDaemonRuntime();
	expect(runtime?.sessionHost).toBe(sessionHost);
	expect(Object.isFrozen(runtime)).toBe(true);
	expect(Object.isFrozen(runtime?.peerIdentity)).toBe(true);
	input.peerIdentity.policyDigest = "b".repeat(64);
	input.sessionHost = {} as HubDaemonRuntime["sessionHost"];
	expect(getHubDaemonRuntime()?.peerIdentity).toEqual(identity);
	expect(getHubDaemonRuntime()?.sessionHost).toBe(sessionHost);
	expect(() =>
		registerHubDaemonRuntime({ sessionHost, peerIdentity: identity }),
	).not.toThrow();
	expect(() => registerHubDaemonRuntime(input)).toThrow("already registered");
	vi.resetModules();
	const reloaded = await import("./runtime-registration");
	expect(reloaded.getHubDaemonRuntime()).toBe(runtime);
	expect(() => reloaded.registerHubDaemonRuntime(input)).toThrow(
		"already registered",
	);
	expected.mockReturnValue({ ...identity, policyDigest: "c".repeat(64) });
	expect(() => reloaded.getHubDaemonRuntime()).toThrow("does not match");
	expected.mockReturnValue({ ...identity, applicationId: "other" });
	expect(() => reloaded.getHubDaemonRuntime()).toThrow("does not match");
	expected.mockImplementation(() => {
		throw new Error("identity unavailable");
	});
	expect(() => reloaded.getHubDaemonRuntime()).toThrow("identity unavailable");
});

// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { registerHubNamespace } from "./hub-namespace";
import {
	captureHubPeerIdentity,
	getRequiredHubPeerIdentity,
	registerHubPeerIdentity,
} from "./hub-peer-identity";

describe("trusted host identity registration", () => {
	it("requires initialization in a mandatory namespace and cannot be replaced", () => {
		expect(getRequiredHubPeerIdentity()).toBeUndefined();
		registerHubNamespace({
			requirePeerIdentity: true,
			hostVariable: "TEST_HOST",
			portVariable: "TEST_PORT",
			discoveryVariable: "TEST_DISCOVERY",
			defaultHost: "127.0.0.1",
			productionPort: 25473,
			developmentPort: 25476,
			pathname: "/hub",
		});
		expect(() => getRequiredHubPeerIdentity()).toThrow(/not initialized/);
		const value = { applicationId: "cline-qb", policyDigest: "a".repeat(64) };
		registerHubPeerIdentity(value);
		value.policyDigest = "b".repeat(64);
		expect(getRequiredHubPeerIdentity()?.policyDigest).toBe("a".repeat(64));
		expect(Object.isFrozen(getRequiredHubPeerIdentity())).toBe(true);
		expect(() =>
			registerHubPeerIdentity({
				applicationId: "cline-qb",
				policyDigest: "a".repeat(64),
			}),
		).not.toThrow();
		expect(() => registerHubPeerIdentity(value)).toThrow(/already registered/);
	});
	it.each([
		undefined,
		{},
		{ applicationId: "../cline", policyDigest: "a".repeat(64) },
		{ applicationId: "cline-qb", policyDigest: "A".repeat(64) },
		{ applicationId: "cline-qb", policyDigest: "" },
	])("rejects malformed identity %j", (value) => {
		expect(() => captureHubPeerIdentity(value)).toThrow();
	});
});

// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { resolveClineHubServerOptions } from "./options";

describe("TEST-QB-002/053: private dashboard configuration", () => {
	it("keeps loopback and the private default port despite inherited upstream controls", () => {
		expect(
			resolveClineHubServerOptions({ CLINE_HUB_DASHBOARD_PORT: "8787" }),
		).toMatchObject({
			host: "127.0.0.1",
			port: 8797,
			publicUrl: "http://127.0.0.1:8797",
		});
	});
	it("reads the private dashboard override", () => {
		expect(
			resolveClineHubServerOptions({
				CLINE_QB_HUB_DASHBOARD_PORT: "9099",
				CLINE_HUB_DASHBOARD_PORT: "8787",
			}).port,
		).toBe(9099);
	});
	it.each([
		"0",
		"65536",
		"8797junk",
		"1e3",
		"NaN",
	])("rejects malformed private port %s", (value) => {
		expect(() =>
			resolveClineHubServerOptions({ CLINE_QB_HUB_DASHBOARD_PORT: value }),
		).toThrow(/CLINE_QB_HUB_DASHBOARD_PORT/);
	});
	it("still requires the room secret for nonlocal binding", () => {
		expect(() => resolveClineHubServerOptions({ HOST: "0.0.0.0" })).toThrow(
			/ROOM_SECRET/,
		);
		expect(
			resolveClineHubServerOptions({
				HOST: "0.0.0.0",
				ROOM_SECRET: "fixture-only",
			}).roomSecret,
		).toBe("fixture-only");
	});
});

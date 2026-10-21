// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { startupFixtureEnvironment } from "./startup-fixture-environment";
const root = resolve("/tmp/fixture-only");
const inherited = {
	PATH: "/usr/bin",
	HOME: "/operator",
	USERPROFILE: "/operator",
	SystemRoot: "C:\\Windows",
	ANTHROPIC_API_KEY: "fake",
	AWS_PROFILE: "fake",
	SSH_AUTH_SOCK: "fake",
	GOOGLE_APPLICATION_CREDENTIALS: "fake",
	NODE_OPTIONS: "--require fake",
	BUN_OPTIONS: "fake",
	CLINE_DIR: "/operator/.cline",
	CLINE_QB_DIR: "/operator/private",
	CLINE_HUB_PORT: "25473",
	CLINE_QB_HUB_PORT: "25473",
	CLINE_QB_HUB_DISCOVERY_PATH: "/operator/hub.json",
	HTTP_PROXY: "http://inherited.invalid",
};
describe("TEST-QB-068 compiled startup environment", () => {
	test("redirects both home APIs", () => {
		const env = startupFixtureEnvironment(root, inherited);
		expect(env.HOME).toBe(join(root, "home"));
		expect(env.USERPROFILE).toBe(env.HOME);
	});
	test("selects private QB roots and discovery", () => {
		const env = startupFixtureEnvironment(root, inherited);
		expect(env.CLINE_QB_DIR).toBe(join(root, "state"));
		expect(env.CLINE_QB_DATA_DIR).toBe(join(root, "state", "data"));
		expect(env.CLINE_QB_HUB_DISCOVERY_PATH).toBe(join(root, "hub.json"));
		expect(env.CLINE_DIR).toBeUndefined();
	});
	test("uses only OS-assigned loopback listeners", () => {
		const env = startupFixtureEnvironment(root, inherited);
		expect(env.CLINE_QB_HUB_PORT).toBe("0");
		expect(env.CLINE_QB_SIDECAR_PORT).toBe("0");
		expect(env.CLINE_QB_HUB_HOST).toBe("127.0.0.1");
	});
	test("excludes credentials, agents and executable injection", () => {
		const env = startupFixtureEnvironment(root, inherited);
		for (const key of [
			"ANTHROPIC_API_KEY",
			"AWS_PROFILE",
			"SSH_AUTH_SOCK",
			"GOOGLE_APPLICATION_CREDENTIALS",
			"NODE_OPTIONS",
			"BUN_OPTIONS",
		]) {
			expect(env[key]).toBeUndefined();
		}
	});
	test("isolates XDG, Windows data and temp roots", () => {
		const env = startupFixtureEnvironment(root, inherited);
		for (const key of [
			"XDG_CONFIG_HOME",
			"XDG_DATA_HOME",
			"XDG_CACHE_HOME",
			"XDG_STATE_HOME",
			"APPDATA",
			"LOCALAPPDATA",
			"TEMP",
			"TMP",
			"TMPDIR",
		]) {
			expect(env[key]?.startsWith(root)).toBe(true);
		}
	});
	test("rejects non-proxy overrides", () => {
		for (const key of [
			"HOME",
			"CLINE_QB_DIR",
			"ANTHROPIC_API_KEY",
			"NODE_OPTIONS",
		]) {
			expect(() =>
				startupFixtureEnvironment(root, inherited, { [key]: "unsafe" }),
			).toThrow(/override/);
		}
	});
	test("inherits OS launch essentials but only explicit proxy configuration", () => {
		const env = startupFixtureEnvironment(root, inherited, {
			HTTPS_PROXY: "http://127.0.0.1:9",
		});
		expect(env.PATH).toBe(inherited.PATH);
		expect(env.SystemRoot).toBe(inherited.SystemRoot);
		expect(env.HTTP_PROXY).toBeUndefined();
		expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:9");
	});
	test("does not source operator login profiles", () => {
		expect(
			startupFixtureEnvironment(root, inherited).CLINE_SIDECAR_SKIP_SHELL_PATH,
		).toBe("1");
	});
	test("rejects relative fixture roots", () => {
		expect(() => startupFixtureEnvironment("relative", inherited)).toThrow(
			/absolute/,
		);
	});
});

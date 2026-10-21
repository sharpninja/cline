// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getHubDaemonLaunchSpec,
	getHubNamespace,
	registerHubDaemonLaunchSpec,
	registerHubNamespace,
} from "@cline/shared";
import { registerStorageNamespace } from "@cline/shared/storage";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { resolveHubEndpointOptions } from "./defaults";
import {
	readHubDiscovery,
	resolveHubOwnerContext,
	withHubStartupLock,
	writeHubDiscovery,
} from "./index";
import { resolveHubInstanceLockPath } from "./instance-lock";
import { resolveProductionHubOwnerContext } from "./workspace";

const root = mkdtempSync(join(tmpdir(), "hub-namespace-"));
const namespace = {
	hostVariable: "PRIVATE_HUB_HOST",
	portVariable: "PRIVATE_HUB_PORT",
	discoveryVariable: "PRIVATE_HUB_DISCOVERY",
	defaultHost: "127.0.0.1",
	productionPort: 25473,
	developmentPort: 25476,
	pathname: "/hub",
};
registerHubNamespace(namespace);
registerStorageNamespace({
	resolvePath: () => join(root, "private"),
	globalRulesPaths: () => [],
	validatePath: (path) => {
		if (path.includes("forbidden")) throw new Error("Forbidden storage path");
		return path;
	},
});
const names = [
	"CLINE_HUB_DISCOVERY_PATH",
	"PRIVATE_HUB_DISCOVERY",
	"CLINE_HUB_BUILD_ID",
	"CLINE_HUB_BUILD_EPOCH_MS",
	"CLINE_WRAPPER_PATH",
	"CLINE_QB_DIR",
];
const env = Object.fromEntries(names.map((key) => [key, process.env[key]]));
afterEach(() => {
	for (const key of names) {
		if (env[key] === undefined) delete process.env[key];
		else process.env[key] = env[key];
	}
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("host namespace through hub discovery", () => {
	it("registers immutable values and rejects replacement", () => {
		expect(Object.isFrozen(getHubNamespace())).toBe(true);
		expect(() => registerHubNamespace({ ...namespace })).not.toThrow();
		expect(() =>
			registerHubNamespace({ ...namespace, productionPort: 9999 }),
		).toThrow(/already registered/);
	});
	it("ignores inherited upstream endpoint variables", () => {
		expect(
			resolveHubEndpointOptions(
				{},
				{
					env: {
						CLINE_HUB_HOST: "upstream",
						CLINE_HUB_PORT: "25463",
						CLINE_HUB_PATHNAME: "/upstream",
					},
					execArgv: [],
				},
			),
		).toEqual({ host: "127.0.0.1", port: 25473, pathname: "/hub" });
	});
	it("uses the private development port", () => {
		expect(
			resolveHubEndpointOptions(
				{},
				{ env: {}, execArgv: ["--conditions=development"] },
			).port,
		).toBe(25476);
	});
	it("uses only host-selected endpoint controls", () => {
		expect(
			resolveHubEndpointOptions(
				{},
				{
					env: {
						PRIVATE_HUB_HOST: "localhost",
						PRIVATE_HUB_PORT: "30001",
						CLINE_HUB_PATHNAME: "/ignored",
					},
					execArgv: [],
				},
			),
		).toEqual({ host: "localhost", port: 30001, pathname: "/hub" });
	});
	it.each([
		"0",
		"-1",
		"65536",
		"25473junk",
		"1e3",
		"NaN",
	])("rejects malformed private port %s", (port) => {
		expect(() =>
			resolveHubEndpointOptions(
				{},
				{ env: { PRIVATE_HUB_PORT: port }, execArgv: [] },
			),
		).toThrow(/port/i);
	});
	it("refuses a pathname override outside the host namespace", () => {
		expect(() => resolveHubEndpointOptions({ pathname: "/upstream" })).toThrow(
			/pathname/i,
		);
	});
	it("preserves explicit ephemeral ports for isolated remote/test instances", () => {
		expect(
			resolveHubEndpointOptions({ port: 0 }, { env: {}, execArgv: [] }).port,
		).toBe(0);
	});
	it("ignores upstream discovery overrides for both owner forms", () => {
		delete process.env.PRIVATE_HUB_DISCOVERY;
		process.env.CLINE_HUB_DISCOVERY_PATH = join(root, "upstream.json");
		expect(resolveHubOwnerContext("fixture").discoveryPath).toContain(
			join(root, "private", "locks", "hub"),
		);
		expect(resolveProductionHubOwnerContext().discoveryPath).toBe(
			join(root, "private", "locks", "hub", "production.json"),
		);
	});
	it("uses the private discovery override for both owner forms", () => {
		const path = join(root, "selected.json");
		process.env.PRIVATE_HUB_DISCOVERY = path;
		expect(resolveHubOwnerContext("fixture").discoveryPath).toBe(path);
		expect(resolveProductionHubOwnerContext().discoveryPath).toBe(path);
	});
	it("validates explicit discovery paths and derived instance/startup lock paths", async () => {
		process.env.PRIVATE_HUB_DISCOVERY = join(root, "forbidden", "record.json");
		expect(() => resolveProductionHubOwnerContext()).toThrow(/Forbidden/);
		expect(() => resolveHubInstanceLockPath(join(root, "forbidden"))).toThrow(
			/Forbidden/,
		);
		await expect(readHubDiscovery(join(root, "forbidden"))).rejects.toThrow(
			/Forbidden/,
		);
		await expect(
			withHubStartupLock(join(root, "forbidden"), async () => {}),
		).rejects.toThrow(/Forbidden/);
		await expect(
			writeHubDiscovery(join(root, "forbidden"), {} as never),
		).rejects.toThrow(/Forbidden/);
	});
});
describe("host daemon launch isolation", () => {
	it("ignores upstream build identity environment hints", async () => {
		const { resolveHubBuildId, resolveHubBuildEpochMs } = await import(
			"./index"
		);
		delete process.env.CLINE_HUB_BUILD_ID;
		delete process.env.CLINE_HUB_BUILD_EPOCH_MS;
		const expected = [resolveHubBuildId(), resolveHubBuildEpochMs()];
		process.env.CLINE_HUB_BUILD_ID = "upstream-spoof";
		process.env.CLINE_HUB_BUILD_EPOCH_MS = "9999999999999";
		expect([resolveHubBuildId(), resolveHubBuildEpochMs()]).toEqual(expected);
	});

	it("requires immutable absolute host launch and preserves the selected child root", async () => {
		const { __test__ } = await import("../daemon");
		expect(() => __test__.resolveLaunchCommand(root, {})).toThrow(
			/not configured/,
		);
		expect(() =>
			registerHubDaemonLaunchSpec({ launcher: "cline-qb", argsPrefix: [] }),
		).toThrow(/absolute/);
		const launcher = join(root, "bin", "cline-qb");
		const argsPrefix = ["--host-mode"];
		registerHubDaemonLaunchSpec({ launcher, argsPrefix });
		argsPrefix.push("--injected");
		expect(Object.isFrozen(getHubDaemonLaunchSpec())).toBe(true);
		expect(Object.isFrozen(getHubDaemonLaunchSpec()?.argsPrefix)).toBe(true);
		expect(() =>
			registerHubDaemonLaunchSpec({ launcher, argsPrefix: ["--host-mode"] }),
		).not.toThrow();
		expect(() =>
			registerHubDaemonLaunchSpec({
				launcher: join(root, "other"),
				argsPrefix: [],
			}),
		).toThrow(/already registered/);
		process.env.CLINE_WRAPPER_PATH = join(root, "upstream", "cline");
		process.env.CLINE_QB_DIR = join(root, "selected-root");
		const command = __test__.resolveLaunchCommand(root, {
			port: 25473,
			host: "127.0.0.1",
			pathname: "/hub",
		});
		expect(command.launcher).toBe(launcher);
		expect(command.args.slice(0, 2)).toEqual([
			"--host-mode",
			"--cline-hub-daemon",
		]);
		expect(command.args).not.toContain("--injected");
		expect(command.cwd).toBe(root);
		expect(command.env.CLINE_QB_DIR).toBe(process.env.CLINE_QB_DIR);
	});
});

// SPDX-License-Identifier: Apache-2.0
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	symlinkSync,
	unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createQbrainStorageNamespace } from "./storage-policy";

let home: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "qb-storage-"));
	env = {};
});
afterEach(() => rmSync(home, { recursive: true, force: true }));
const context = () => ({ homeDir: home });
const policy = () => createQbrainStorageNamespace({ homeDir: home, env });
const overrides = [
	["CLINE_QB_DIR", "root"],
	["CLINE_QB_DATA_DIR", "data"],
	["CLINE_QB_SESSION_DATA_DIR", "sessions"],
	["CLINE_QB_PROVIDER_SETTINGS_PATH", "providerSettings"],
	["CLINE_QB_GLOBAL_SETTINGS_PATH", "globalSettings"],
	["CLINE_QB_MCP_SETTINGS_PATH", "mcpSettings"],
] as const;

describe("TEST-QB-002/053: private storage namespace", () => {
	it("derives every storage root without creating files or directories", () => {
		const p = policy();
		const root = join(home, ".cline-qb");
		const data = join(root, "data");
		const expected = {
			root,
			data,
			sessions: join(data, "sessions"),
			teams: join(data, "teams"),
			connectors: join(data, "connectors"),
			connectorSettings: join(data, "connectors", "settings.json"),
			database: join(data, "db"),
			connectorsDatabase: join(data, "db", "connectors.db"),
			cronDatabase: join(data, "db", "cron.db"),
			tasksDatabase: join(data, "db", "tasks.db"),
			providerSettings: join(data, "settings", "providers.json"),
			globalSettings: join(data, "settings", "global-settings.json"),
			mcpSettings: join(data, "settings", "cline_mcp_settings.json"),
			documents: root,
		};
		for (const [kind, path] of Object.entries(expected))
			expect(p.resolvePath(kind as keyof typeof expected, context())).toBe(
				path,
			);
		expect(p.globalRulesPaths(context())).toEqual([
			join(root, "rules"),
			join(root, "Rules"),
		]);
		expect(readdirSync(home)).toEqual([]);
	});
	it("ignores all upstream path variables and derives subsidiary databases from private data", () => {
		for (const name of [
			"DIR",
			"DATA_DIR",
			"SESSION_DATA_DIR",
			"PROVIDER_SETTINGS_PATH",
			"GLOBAL_SETTINGS_PATH",
			"MCP_SETTINGS_PATH",
			"TEAM_DATA_DIR",
			"CONNECTOR_DATA_DIR",
			"CONNECTOR_SETTINGS_PATH",
			"DB_DATA_DIR",
			"CONNECTORS_DB_PATH",
			"CRON_DB_PATH",
			"TASKS_DB_PATH",
		])
			env[`CLINE_${name}`] = join(home, ".cline", name);
		env.CLINE_QB_DATA_DIR = join(home, "private-data");
		const p = policy();
		expect(p.resolvePath("root", context())).toBe(join(home, ".cline-qb"));
		for (const kind of [
			"sessions",
			"teams",
			"connectors",
			"connectorSettings",
			"database",
			"connectorsDatabase",
			"cronDatabase",
			"tasksDatabase",
			"providerSettings",
			"globalSettings",
			"mcpSettings",
		] as const)
			expect(
				p.resolvePath(kind, context()).startsWith(join(home, "private-data")),
			).toBe(true);
	});
	it.each(
		overrides,
	)("rejects %s pointing into upstream storage", (key, kind) => {
		env[key] = join(home, ".cline", "nested", "missing");
		expect(() => policy().resolvePath(kind, context())).toThrow(
			"upstream Cline",
		);
	});
	it.each(overrides)("honors valid %s overrides", (key, kind) => {
		env[key] = join(home, "private", key);
		expect(policy().resolvePath(kind, context())).toBe(env[key]);
	});
	it("rejects explicit root overrides and preserves vendor-neutral workspace inputs", () => {
		const p = policy();
		expect(() =>
			p.resolvePath("root", {
				...context(),
				rootOverride: join(home, ".cline"),
			}),
		).toThrow("upstream Cline");
		expect(
			p.resolvePath("root", {
				...context(),
				rootOverride: join(home, "other"),
			}),
		).toBe(join(home, "other"));
		expect(p.resolvePath("root", { homeDir: join(home, "changed-home") })).toBe(
			join(home, ".cline-qb"),
		);
	});
	it("rejects Documents, OneDrive, XDG and host-resolved known-folder roots", () => {
		env.OneDrive = join(home, "drive");
		env.XDG_DOCUMENTS_DIR = "$HOME/local-docs";
		const extra = join(home, "os-known-docs");
		const p = createQbrainStorageNamespace({
			homeDir: home,
			env,
			documentsDirs: [extra],
		});
		for (const root of [
			join(home, "Cline"),
			join(home, "Documents", "Cline"),
			join(home, "drive", "Documents", "Cline"),
			join(home, "local-docs", "Cline"),
			join(extra, "Cline"),
		]) {
			env.CLINE_QB_DATA_DIR = join(root, "nested");
			expect(() => p.resolvePath("data", context())).toThrow("upstream Cline");
		}
	});
	it("rejects existing symlink aliases before returning a nonexisting child", () => {
		const upstream = join(home, ".cline");
		mkdirSync(upstream);
		const alias = join(home, "alias");
		symlinkSync(upstream, alias, "junction");
		env.CLINE_QB_DATA_DIR = join(alias, "not-created");
		expect(() => policy().resolvePath("data", context())).toThrow(
			"upstream Cline",
		);
		expect(readdirSync(upstream)).toEqual([]);
	});
	it("rejects dangling symlink aliases into not-yet-created upstream roots", () => {
		const alias = join(home, "dangling");
		symlinkSync(join(home, ".cline", "future"), alias, "junction");
		env.CLINE_QB_DATA_DIR = join(alias, "nested");
		expect(() => policy().resolvePath("data", context())).toThrow(
			"upstream Cline",
		);
	});
	it("rechecks aliases after path resolution and fails closed on cycles", () => {
		const safe = join(home, "safe");
		mkdirSync(safe);
		const alias = join(home, "alias");
		symlinkSync(safe, alias, "junction");
		env.CLINE_QB_DATA_DIR = join(alias, "nested");
		const p = policy();
		expect(p.resolvePath("data", context())).toBe(join(safe, "nested"));
		unlinkSync(alias);
		symlinkSync(join(home, ".cline"), alias, "junction");
		expect(() => p.resolvePath("data", context())).toThrow("upstream Cline");
		unlinkSync(alias);
		symlinkSync(alias, alias, "junction");
		expect(() => p.resolvePath("data", context())).toThrow();
	});
	it("allows sibling names and rejects malformed roots", () => {
		env.CLINE_QB_DIR = join(home, ".cline-backup");
		expect(policy().resolvePath("root", context())).toBe(env.CLINE_QB_DIR);
		expect(() => createQbrainStorageNamespace({ homeDir: "", env })).toThrow(
			"absolute home",
		);
	});
});

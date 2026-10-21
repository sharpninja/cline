import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The sidecar reaches Composio only through the Cline API connectors proxy
 * (`./cline-connectors-api`). Tests mock that module and drive its behavior
 * per test, so no network — and no Composio key — is involved. `ConnectorsApiError`
 * is kept real so status-code handling (401/403/404) is exercised faithfully.
 */
const identity = vi.hoisted(() => ({
	accountId: "account-a" as string | undefined,
}));
vi.mock("./cline-auth", async () => ({
	...(await vi.importActual<typeof import("./cline-auth")>("./cline-auth")),
	getClineAccountId: () => identity.accountId,
}));

const beta = vi.hoisted(() => ({ enabled: true }));
vi.mock("@cline/core", async () => ({
	...(await vi.importActual<typeof import("@cline/core")>("@cline/core")),
	isClineAccountFeatureEnabled: async () => beta.enabled,
}));

const proxy = vi.hoisted(() => ({
	fetchConnectableToolkits: vi.fn(),
	initiateConnection: vi.fn(),
	listConnections: vi.fn(),
	deleteConnection: vi.fn(),
	listToolkitTools: vi.fn(),
	waitForConnectionActive: vi.fn(),
}));

vi.mock("./cline-connectors-api", async () => {
	const actual = await vi.importActual<typeof import("./cline-connectors-api")>(
		"./cline-connectors-api",
	);
	return {
		ConnectorsApiError: actual.ConnectorsApiError,
		rejectClineConnectors: actual.rejectClineConnectors,
		fetchConnectableToolkits: proxy.fetchConnectableToolkits,
		initiateConnection: proxy.initiateConnection,
		listConnections: proxy.listConnections,
		deleteConnection: proxy.deleteConnection,
		listToolkitTools: proxy.listToolkitTools,
		waitForConnectionActive: proxy.waitForConnectionActive,
	};
});

import { ConnectorsApiError } from "./cline-connectors-api";
import {
	__resetComposioCachesForTesting,
	abandonComposioConnectsForOwner,
	cancelComposioConnect,
	connectComposioToolkit,
	disconnectComposioToolkit,
	getComposioStatus,
	listComposioToolkits,
	parseComposioToolkitSlug,
} from "./composio";

const originalDataDir = process.env.CLINE_DATA_DIR;
const originalClineDir = process.env.CLINE_DIR;
const cleanupPaths: string[] = [];

function useTempDataDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "composio-proxy-test-"));
	cleanupPaths.push(dir);
	process.env.CLINE_DATA_DIR = dir;
	process.env.CLINE_DIR = dir;
	return dir;
}

function statePath(
	dataDir: string,
	accountId = identity.accountId ?? "account-a",
): string {
	return join(
		dataDir,
		"settings",
		"composio",
		`${createHash("sha256").update(accountId).digest("hex")}.json`,
	);
}

function writeState(dataDir: string, state: unknown): void {
	const settingsDir = join(dataDir, "settings", "composio");
	mkdirSync(settingsDir, { recursive: true });
	writeFileSync(statePath(dataDir), JSON.stringify(state, null, "\t"));
}

function readStateFile(dataDir: string): {
	toolkits?: Record<
		string,
		{ connectedAccountId?: string; tools?: unknown[] } | undefined
	>;
	cancelledAccountIds?: string[];
} {
	return JSON.parse(readFileSync(statePath(dataDir), "utf8"));
}

/** Signed-in and entitled: the availability probe (listConnections) succeeds. */
function makeAvailable(connections: unknown[] = []): void {
	proxy.listConnections.mockResolvedValue(connections);
}

beforeEach(() => {
	identity.accountId = "account-a";
	beta.enabled = true;
	vi.clearAllMocks();
	__resetComposioCachesForTesting();
	// Sensible defaults; individual tests override.
	proxy.listConnections.mockResolvedValue([]);
	proxy.listToolkitTools.mockResolvedValue([]);
	proxy.deleteConnection.mockResolvedValue(undefined);
	proxy.fetchConnectableToolkits.mockResolvedValue([]);
	// waitForConnectionActive resolves immediately by default (connection active).
	proxy.waitForConnectionActive.mockResolvedValue(undefined);
});

afterEach(() => {
	if (originalDataDir === undefined) delete process.env.CLINE_DATA_DIR;
	else process.env.CLINE_DATA_DIR = originalDataDir;
	if (originalClineDir === undefined) delete process.env.CLINE_DIR;
	else process.env.CLINE_DIR = originalClineDir;
	for (const path of cleanupPaths.splice(0)) {
		rmSync(path, { recursive: true, force: true });
	}
});

describe("parseComposioToolkitSlug", () => {
	it("accepts well-formed slugs case-insensitively and rejects malformed ones", () => {
		expect(parseComposioToolkitSlug("Gmail ")).toBe("gmail");
		expect(parseComposioToolkitSlug("googlecalendar")).toBe("googlecalendar");
		expect(() => parseComposioToolkitSlug("bad slug!")).toThrow(
			/Invalid Composio toolkit slug/,
		);
	});
});

describe("Cline Composio management exclusion", () => {
	it.each([
		true,
		false,
	])("hides saved integrations/catalog and preserves state with beta=%s", async (enabled) => {
		beta.enabled = enabled;
		const dataDir = useTempDataDir();
		writeState(dataDir, {
			toolkits: {
				gmail: {
					connectedAccountId: "legacy-gmail",
					tools: [{ slug: "GMAIL_SEND_EMAIL" }],
				},
			},
			cancelledAccountIds: ["legacy-cancelled"],
		});
		const path = statePath(dataDir);
		const before = readFileSync(path, "utf8");
		const legacyPlugin = join(dataDir, "plugins", "composio-tools.ts");
		mkdirSync(join(dataDir, "plugins"));
		writeFileSync(legacyPlugin, "synthetic legacy plugin");
		for (const refresh of [false, true, true])
			expect(await getComposioStatus({ refresh })).toEqual({
				configured: false,
				integrations: [],
			});
		expect(await listComposioToolkits()).toEqual({
			configured: false,
			toolkits: [],
		});
		expect(readFileSync(path, "utf8")).toBe(before);
		expect(readFileSync(legacyPlugin, "utf8")).toBe("synthetic legacy plugin");
		for (const call of Object.values(proxy))
			expect(call).not.toHaveBeenCalled();
	});
	it.each([
		"connect",
		"disconnect",
	])("refuses %s without asking for Cline sign-in or changing saved state", async (operation) => {
		const dataDir = useTempDataDir();
		writeState(dataDir, {
			toolkits: { gmail: { connectedAccountId: "legacy-gmail", tools: [] } },
		});
		const before = readFileSync(statePath(dataDir), "utf8");
		await expect(
			operation === "connect"
				? connectComposioToolkit("gmail")
				: disconnectComposioToolkit("gmail"),
		).rejects.toThrow(/Cline connectors.*unavailable/i);
		expect(readFileSync(statePath(dataDir), "utf8")).toBe(before);
		for (const call of Object.values(proxy))
			expect(call).not.toHaveBeenCalled();
	});
	it("cancels and tears down owners without creating remote cleanup work", async () => {
		const dataDir = useTempDataDir();
		writeState(dataDir, { cancelledAccountIds: ["old"] });
		const before = readFileSync(statePath(dataDir), "utf8");
		await cancelComposioConnect("gmail");
		expect(abandonComposioConnectsForOwner({})).toBe(0);
		expect(readFileSync(statePath(dataDir), "utf8")).toBe(before);
		for (const call of Object.values(proxy))
			expect(call).not.toHaveBeenCalled();
	});
});

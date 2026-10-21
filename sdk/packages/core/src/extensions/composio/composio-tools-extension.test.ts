import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Connector tools execute through the Cline API connectors proxy, so the
 * extension resolves a Cline account token. Mock the token resolution so
 * tests can drive the signed-in / signed-out cases without a real account.
 */
const beta = vi.hoisted(() => ({ enabled: true }));
vi.mock("../../services/feature-flags/cline-account-feature-flags", () => ({
	isClineAccountFeatureEnabled: async () => beta.enabled,
}));

const auth = vi.hoisted(() => ({
	token: "cline_token_123" as string | undefined,
	accountId: "account-a" as string | undefined,
	baseUrl: "https://api.cline.bot",
}));

vi.mock("../../runtime/orchestration/runtime-oauth-token-manager", () => ({
	OAuthReauthRequiredError: class extends Error {},
	RuntimeOAuthTokenManager: class {
		async resolveProviderApiKey() {
			return auth.token ? { apiKey: auth.token } : null;
		}
	},
}));
vi.mock("../../services/providers/local-provider-service", () => ({
	resolveLocalClineAuthToken: () => auth.token,
}));
vi.mock("../../services/storage/provider-settings-manager", () => ({
	ProviderSettingsManager: class {
		getProviderSettings() {
			return { baseUrl: auth.baseUrl, auth: { accountId: auth.accountId } };
		}
	},
}));

import {
	createComposioToolsExtension,
	resolveComposioToolsStatePath,
} from "./composio-tools-extension";

type RegisteredTool = {
	name: string;
	resultPolicy?: "cache-oversized";
	description: string;
	inputSchema: Record<string, unknown>;
	retryable?: boolean;
	execute: (input: unknown, context?: unknown) => Promise<unknown>;
};

const originalDataDir = process.env.CLINE_DATA_DIR;
let tempDataDir: string;

function writeState(state: unknown): void {
	const path = resolveComposioToolsStatePath(auth.accountId ?? "account-a");
	const settingsDir = dirname(path);
	mkdirSync(settingsDir, { recursive: true });
	writeFileSync(path, JSON.stringify(state, null, "\t"));
}

async function setupTools(): Promise<RegisteredTool[]> {
	const extension = await createComposioToolsExtension();
	const tools: RegisteredTool[] = [];
	if (!extension) {
		return tools;
	}
	await extension.setup?.(
		{
			registerTool: (tool: unknown) => tools.push(tool as RegisteredTool),
		} as never,
		{} as never,
	);
	return tools;
}

beforeEach(() => {
	beta.enabled = true;
	tempDataDir = mkdtempSync(join(tmpdir(), "composio-ext-test-"));
	process.env.CLINE_DATA_DIR = tempDataDir;
	auth.token = "cline_token_123";
	auth.accountId = "account-a";
	auth.baseUrl = "https://api.cline.bot";
});

afterEach(() => {
	if (originalDataDir === undefined) {
		delete process.env.CLINE_DATA_DIR;
	} else {
		process.env.CLINE_DATA_DIR = originalDataDir;
	}
	vi.unstubAllGlobals();
	rmSync(tempDataDir, { recursive: true, force: true });
});

describe("Composio exclusion (AC-QB-016/017)", () => {
	it.each([
		true,
		false,
	])("does not activate saved tools with beta=%s, even across account changes", async (enabled) => {
		beta.enabled = enabled;
		const fetch = vi.fn(async () => {
			throw new Error("Unexpected Cline request");
		});
		vi.stubGlobal("fetch", fetch);
		for (const accountId of ["account-a", "account-b", "account-a"]) {
			auth.accountId = accountId;
			writeState({
				toolkits: {
					gmail: {
						connectedAccountId: "synthetic",
						tools: [{ slug: "GMAIL_SEND_EMAIL" }],
					},
				},
			});
			const path = resolveComposioToolsStatePath(accountId);
			const before = readFileSync(path, "utf8");
			expect(await createComposioToolsExtension()).toBeUndefined();
			expect(await setupTools()).toEqual([]);
			expect(readFileSync(path, "utf8")).toBe(before);
		}
		expect(fetch).not.toHaveBeenCalled();
	});
	it("remains inert for fresh and malformed cached state", async () => {
		expect(await createComposioToolsExtension()).toBeUndefined();
		writeState({
			toolkits: {
				gmail: {
					connectedAccountId: "old",
					tools: [{ slug: "OLD_TOOL", input_parameters: null }],
				},
			},
		});
		expect(await createComposioToolsExtension()).toBeUndefined();
	});
	it("keeps account state paths deterministic and distinct without loading tools", () => {
		expect(resolveComposioToolsStatePath("a")).toBe(
			resolveComposioToolsStatePath("a"),
		);
		expect(resolveComposioToolsStatePath("a")).not.toBe(
			resolveComposioToolsStatePath("b"),
		);
	});
});

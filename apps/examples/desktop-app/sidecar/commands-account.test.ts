import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isClineAccountNotAuthenticatedResult } from "../webview/lib/cline-account-state";
import type { SidecarContext } from "./types";

const clineAccountServiceCtorMock = vi.hoisted(() => vi.fn());
const executeClineAccountActionMock = vi.hoisted(() => vi.fn());
const getProviderSettingsMock = vi.hoisted(() => vi.fn());
const saveProviderSettingsMock = vi.hoisted(() => vi.fn());
const persistProviderSettingsMock = vi.hoisted(() => vi.fn());
const resolveProviderApiKeyMock = vi.hoisted(() => vi.fn());
const clearLegacyProviderCredentialsMock = vi.hoisted(() => vi.fn());
const runProviderOAuthLoginMock = vi.hoisted(() => vi.fn());
let testDataDir: string;

vi.mock("./oauth-login", () => ({
	runCancellableProviderOAuthLogin: runProviderOAuthLoginMock,
	cancelProviderOAuthLogin: vi.fn(),
}));

vi.mock("./legacy-provider-credentials", () => ({
	clearLegacyProviderCredentials: clearLegacyProviderCredentialsMock,
}));

vi.mock("@cline/core", async () => {
	const actual =
		await vi.importActual<typeof import("@cline/core")>("@cline/core");
	return {
		...actual,
		ClineAccountService: class {
			constructor(options: unknown) {
				clineAccountServiceCtorMock(options);
			}
		},
		executeClineAccountAction: executeClineAccountActionMock,
		ProviderSettingsManager: class {
			getProviderSettings = getProviderSettingsMock;
			saveProviderSettings = persistProviderSettingsMock;
		},
		saveLocalProviderSettings: saveProviderSettingsMock,
		RuntimeOAuthTokenManager: class {
			resolveProviderApiKey = resolveProviderApiKeyMock;
		},
	};
});

function createContext() {
	const capture = vi.fn();
	const setDistinctId = vi.fn();
	const updateCommonProperties = vi.fn();
	const ctx = {
		telemetry: { capture, setDistinctId, updateCommonProperties },
		logger: { debug: vi.fn(), log: vi.fn(), error: vi.fn() },
		wsClients: new Set(),
		liveSessions: new Map(),
	} as unknown as SidecarContext;
	return { ctx, capture, setDistinctId, updateCommonProperties };
}

const FETCH_ME_ARGS = {
	action: "clineAccount",
	operation: "fetchMe",
} as const;

async function runClineAccountCommand(ctx: SidecarContext) {
	const { handleCommand } = await import("./commands");
	return handleCommand(ctx, "cline_account", { ...FETCH_ME_ARGS });
}

beforeEach(() => {
	// Account context is persisted across launches; never hydrate the developer's
	// signed-in identity when a test expects an anonymous device identity.
	testDataDir = mkdtempSync(join(tmpdir(), "commands-account-test-"));
	vi.stubEnv("CLINE_DATA_DIR", testDataDir);
	vi.stubEnv("CLINE_DIR", testDataDir);
	clineAccountServiceCtorMock.mockReset();
	executeClineAccountActionMock.mockReset();
	getProviderSettingsMock.mockReset();
	saveProviderSettingsMock.mockReset();
	persistProviderSettingsMock.mockReset();
	resolveProviderApiKeyMock.mockReset();
	clearLegacyProviderCredentialsMock.mockReset();
	runProviderOAuthLoginMock
		.mockReset()
		.mockResolvedValue({ accessToken: "token" });
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(testDataDir, { recursive: true, force: true });
});
describe("desktop Cline account exclusion", () => {
	for (const operation of [
		"fetchMe",
		"fetchBalance",
		"fetchUserOrganizations",
		"fetchOrganizationBalance",
		"fetchUsageTransactions",
		"fetchOrganizationUsageTransactions",
		"fetchPaymentTransactions",
		"switchAccount",
		"",
	]) {
		it.each([
			false,
			true,
		])(`rejects ${operation} with saved credentials=%s before account/auth/storage work`, async (legacy) => {
			const { ctx, capture, setDistinctId, updateCommonProperties } =
				createContext();
			getProviderSettingsMock.mockReturnValue(
				legacy
					? {
							auth: {
								accessToken: "synthetic-token",
								accountId: "old-account",
							},
						}
					: undefined,
			);
			resolveProviderApiKeyMock.mockResolvedValue({
				apiKey: "synthetic-refreshed",
			});
			const { handleCommand } = await import("./commands");
			await expect(
				handleCommand(ctx, "cline_account", {
					action: "clineAccount",
					operation,
				}),
			).rejects.toThrow(/Cline account services are unavailable/);
			for (const mock of [
				getProviderSettingsMock,
				resolveProviderApiKeyMock,
				executeClineAccountActionMock,
				clineAccountServiceCtorMock,
				persistProviderSettingsMock,
				capture,
				setDistinctId,
				updateCommonProperties,
			])
				expect(mock).not.toHaveBeenCalled();
		});
	}
	for (const command of [
		"run_provider_oauth_login",
		"save_provider_settings",
	]) {
		it.each([
			"cline",
			"cline-pass",
			" CLINE ",
		])(`rejects ${command} for %s without persistence or legacy deletion`, async (provider) => {
			const { ctx } = createContext();
			const { handleCommand } = await import("./commands");
			saveProviderSettingsMock.mockResolvedValue({
				providerId: provider,
				enabled: true,
			});
			await expect(
				handleCommand(ctx, command, {
					provider,
					enabled: false,
					api_key: "",
					settings: { auth: { accessToken: "" } },
				}),
			).rejects.toThrow(/Cline account services are unavailable/);
			for (const mock of [
				getProviderSettingsMock,
				saveProviderSettingsMock,
				clearLegacyProviderCredentialsMock,
				runProviderOAuthLoginMock,
			])
				expect(mock).not.toHaveBeenCalled();
		});
	}
	it("still allows explicit direct-provider OAuth", async () => {
		const { ctx } = createContext();
		const { handleCommand } = await import("./commands");
		await expect(
			handleCommand(ctx, "run_provider_oauth_login", {
				provider: "openai-codex",
			}),
		).resolves.toEqual({ accessToken: "token" });
		expect(runProviderOAuthLoginMock).toHaveBeenCalledOnce();
		expect(resolveProviderApiKeyMock).not.toHaveBeenCalled();
	});
	it("still saves an explicit direct provider without Cline account work", async () => {
		const { ctx } = createContext();
		const { handleCommand } = await import("./commands");
		saveProviderSettingsMock.mockResolvedValue({
			providerId: "anthropic",
			enabled: true,
		});
		await expect(
			handleCommand(ctx, "save_provider_settings", {
				provider: "anthropic",
				api_key: "synthetic-direct",
			}),
		).resolves.toEqual({ providerId: "anthropic", enabled: true });
		expect(saveProviderSettingsMock).toHaveBeenCalledOnce();
		expect(resolveProviderApiKeyMock).not.toHaveBeenCalled();
		expect(executeClineAccountActionMock).not.toHaveBeenCalled();
	});
});

it("retains explicit direct-provider sign-out cleanup without touching Cline credentials", async () => {
	const { ctx } = createContext();
	const { handleCommand } = await import("./commands");
	saveProviderSettingsMock.mockResolvedValue({
		providerId: "openai-codex",
		enabled: false,
	});
	await expect(
		handleCommand(ctx, "save_provider_settings", {
			provider: "openai-codex",
			enabled: false,
		}),
	).resolves.toEqual({ providerId: "openai-codex", enabled: false });
	expect(clearLegacyProviderCredentialsMock).toHaveBeenCalledExactlyOnceWith(
		"openai-codex",
	);
	expect(getProviderSettingsMock).not.toHaveBeenCalled();
	expect(resolveProviderApiKeyMock).not.toHaveBeenCalled();
	expect(executeClineAccountActionMock).not.toHaveBeenCalled();
});

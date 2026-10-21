import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isClineAccountNotAuthenticatedResult } from "../webview/lib/cline-account-state";
import {
	listClineGitHubRepositories,
	listClineIntegrations,
	resolveGitHubInstallUrl,
} from "./commands-integrations";
import type { SidecarContext } from "./types";

const getProviderSettingsMock = vi.hoisted(() => vi.fn());
const resolveProviderApiKeyMock = vi.hoisted(() => vi.fn());

vi.mock("@cline/core", async () => {
	const actual =
		await vi.importActual<typeof import("@cline/core")>("@cline/core");
	return {
		...actual,
		ProviderSettingsManager: class {
			getProviderSettings = getProviderSettingsMock;
		},
		RuntimeOAuthTokenManager: class {
			resolveProviderApiKey = resolveProviderApiKeyMock;
		},
	};
});

function createContext() {
	const capture = vi.fn();
	const ctx = {
		telemetry: { capture },
		logger: { debug: vi.fn(), log: vi.fn(), error: vi.fn() },
	} as unknown as SidecarContext;
	return { ctx, capture };
}

const REQUEST_OPTIONS = {
	apiBaseUrl: "https://api.example.com",
	appBaseUrl: "https://app.example.com",
	authToken: "test-token",
} as const;

function requestOptions(fetchImpl: ReturnType<typeof vi.fn>) {
	return {
		...REQUEST_OPTIONS,
		fetchImpl: fetchImpl as unknown as typeof fetch,
	};
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

beforeEach(() => {
	getProviderSettingsMock.mockReset();
	resolveProviderApiKeyMock.mockReset();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("Cline integration exclusion", () => {
	for (const [name, operation] of Object.entries({
		listClineIntegrations,
		listClineGitHubRepositories,
		resolveGitHubInstallUrl,
	})) {
		it(`refuses ${name} without calling the supplied transport`, async () => {
			const fetchImpl = vi.fn(async () =>
				jsonResponse({ success: true, data: [] }),
			);
			await expect(operation(requestOptions(fetchImpl))).rejects.toThrow(
				/Cline account services are unavailable/,
			);
			expect(fetchImpl).not.toHaveBeenCalled();
		});
	}
	for (const operation of [
		"list",
		"listGitHubRepositories",
		"githubInstallUrl",
		"",
	]) {
		it.each([
			false,
			true,
		])(`refuses ${operation} with legacy=%s before refresh or network`, async (legacy) => {
			const fetch = vi.fn(async () =>
				jsonResponse({ success: true, data: [] }),
			);
			vi.stubGlobal("fetch", fetch);
			getProviderSettingsMock.mockReturnValue(
				legacy ? { auth: { accessToken: "old-token" } } : undefined,
			);
			resolveProviderApiKeyMock.mockResolvedValue({
				apiKey: "refreshed-token",
			});
			const { ctx } = createContext();
			const { handleCommand } = await import("./commands");
			await expect(
				handleCommand(ctx, "cline_integrations", { operation }),
			).rejects.toThrow(/Cline account services are unavailable/);
			expect(getProviderSettingsMock).not.toHaveBeenCalled();
			expect(resolveProviderApiKeyMock).not.toHaveBeenCalled();
			expect(fetch).not.toHaveBeenCalled();
		});
	}
});

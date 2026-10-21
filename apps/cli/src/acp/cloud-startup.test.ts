// SPDX-License-Identifier: Apache-2.0
import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
	settings: vi.fn(),
	last: vi.fn(),
	models: vi.fn(async () => ({})),
	create: vi.fn(async () => {
		throw new Error("unexpected runtime construction");
	}),
	prompt: vi.fn(async () => "system"),
}));
vi.mock("@cline/core", async (original) => {
	const actual = await original<typeof import("@cline/core")>();
	return {
		...actual,
		ProviderSettingsManager: class {
			getProviderSettings(id: string) {
				return calls.settings(id);
			}
			getLastUsedProviderSettings() {
				return calls.last();
			}
		},
		Llms: { ...actual.Llms, getModelsForProvider: calls.models },
	};
});
vi.mock("../session/session", () => ({ createCliCore: calls.create }));
vi.mock("../runtime/prompt", () => ({ resolveSystemPrompt: calls.prompt }));

import { buildConnectorStartRequest } from "../connectors/session-runtime";
import { AcpAgent } from "./acpAgent";
import { ACP_AUTH_METHODS } from "./auth";

const conn = {
	sessionUpdate: vi.fn(async () => {}),
} as unknown as AgentSideConnection;
const connector = (provider?: string) =>
	buildConnectorStartRequest({
		options: {
			cwd: "/tmp",
			provider,
			apiKey: "fixture",
			mode: "act",
			enableTools: false,
		},
		io: { writeln: vi.fn(), writeErr: vi.fn() },
		loggerConfig: { enabled: false, level: "info", destination: "stdout" },
		systemRules: "rules",
		defaultModel: "fixture-model",
	});
beforeEach(() => {
	vi.clearAllMocks();
	calls.settings.mockReturnValue(undefined);
	calls.last.mockReturnValue(undefined);
	vi.stubEnv("CLINE_QB_PROVIDER", "");
	vi.stubEnv("CLINE_QB_API_KEY", "");
	vi.stubEnv("CLINE_QB_MODEL", "fixture-model");
});
afterEach(() => vi.unstubAllEnvs());
describe("TEST-QB-016/017: provider startup and restore", () => {
	it.each([
		"cline",
		"cline-pass",
		" cline ",
	])("connector refuses explicit %s before any provider credentials", async (provider) => {
		await expect(connector(provider)).rejects.toThrow(
			"Configure a direct model provider",
		);
		expect(calls.last).not.toHaveBeenCalled();
		expect(calls.settings).not.toHaveBeenCalled();
		expect(calls.prompt).not.toHaveBeenCalled();
	});
	it.each([
		"cline",
		"cline-pass",
		undefined,
	])("connector refuses missing or inherited cloud provider %s", async (provider) => {
		calls.last.mockReturnValue(provider ? { provider } : undefined);
		await expect(connector()).rejects.toThrow(
			"Configure a direct model provider",
		);
		expect(calls.settings).not.toHaveBeenCalled();
		expect(calls.prompt).not.toHaveBeenCalled();
	});
	it.each([
		"cline",
		"cline-pass",
		" cline ",
	])("ACP refuses explicit %s before restore and catalog", async (provider) => {
		vi.stubEnv("CLINE_QB_PROVIDER", provider);
		vi.stubEnv("CLINE_QB_API_KEY", "fixture");
		const agent = new AcpAgent(conn);
		await expect(
			agent.newSession({ cwd: "/tmp", mcpServers: [] }),
		).rejects.toThrow("Configure a direct model provider");
		expect(calls.settings).not.toHaveBeenCalled();
		expect(calls.models).not.toHaveBeenCalled();
		expect(calls.create).not.toHaveBeenCalled();
	});
	it("ACP refuses cloud load before constructing a runtime", async () => {
		vi.stubEnv("CLINE_QB_PROVIDER", "cline");
		vi.stubEnv("CLINE_QB_API_KEY", "fixture");
		await expect(
			new AcpAgent(conn).loadSession({
				sessionId: "old",
				cwd: "/tmp",
				mcpServers: [],
			}),
		).rejects.toThrow("Configure a direct model provider");
		expect(calls.models).not.toHaveBeenCalled();
		expect(calls.create).not.toHaveBeenCalled();
	});
	it("ACP does not restore or advertise Cline credentials", async () => {
		calls.settings.mockImplementation((id: string) =>
			id === "cline"
				? { provider: id, apiKey: "fixture-inherited" }
				: undefined,
		);
		await expect(
			new AcpAgent(conn).newSession({ cwd: "/tmp", mcpServers: [] }),
		).rejects.toThrow(/direct model provider/i);
		expect(calls.settings).not.toHaveBeenCalledWith("cline");
		expect(calls.settings).not.toHaveBeenCalledWith("cline-pass");
		expect(ACP_AUTH_METHODS.map((m) => m.id)).not.toContain("cline");
		expect(ACP_AUTH_METHODS.map((m) => m.id)).not.toContain("cline-pass");
		expect(calls.models).not.toHaveBeenCalled();
	});
	it("ACP requires an explicit provider even with inherited API key", async () => {
		vi.stubEnv("CLINE_QB_API_KEY", "fixture");
		await expect(
			new AcpAgent(conn).newSession({ cwd: "/tmp", mcpServers: [] }),
		).rejects.toThrow(/direct model provider/i);
		expect(calls.models).not.toHaveBeenCalled();
	});
	it("ACP preserves explicit direct provider selection", async () => {
		vi.stubEnv("CLINE_QB_PROVIDER", "openai-codex");
		vi.stubEnv("CLINE_QB_API_KEY", "fixture");
		const result = await new AcpAgent(conn).newSession({
			cwd: "/tmp",
			mcpServers: [],
		});
		expect(result.sessionId).toBeTruthy();
		expect(calls.models).toHaveBeenCalledWith(
			"openai-codex",
			expect.any(Object),
		);
		expect(calls.settings).not.toHaveBeenCalledWith("cline");
	});
});
it("TEST-QB-016/017 ignores inherited Cline environment credentials", async () => {
	vi.stubEnv("CLINE_PROVIDER", "cline");
	vi.stubEnv("CLINE_API_KEY", "fixture-cloud-token");
	vi.stubEnv("CLINE_MODEL", "fixture-cloud-model");
	vi.stubEnv("CLINE_QB_PROVIDER", "openai-codex");
	await expect(
		new AcpAgent(conn).newSession({ cwd: "/tmp", mcpServers: [] }),
	).rejects.toThrow(/direct model provider/i);
	expect(calls.models).not.toHaveBeenCalled();
	expect(calls.create).not.toHaveBeenCalled();
});
it("TEST-QB-016/017 cross-provider saved credentials are not restored", async () => {
	calls.settings.mockImplementation((id: string) =>
		id === "openai-codex"
			? { provider: id, apiKey: "fixture-other-provider" }
			: undefined,
	);
	vi.stubEnv("CLINE_QB_PROVIDER", "anthropic");
	await expect(
		new AcpAgent(conn).newSession({ cwd: "/tmp", mcpServers: [] }),
	).rejects.toThrow(/direct model provider/i);
	expect(calls.settings).not.toHaveBeenCalledWith("openai-codex");
	expect(calls.models).not.toHaveBeenCalled();
});
it("TEST-QB-016/017 cross-provider cached auth cannot follow an environment switch", async () => {
	calls.settings.mockImplementation((id: string) =>
		id === "openai-codex"
			? { provider: id, apiKey: "fixture-other-provider" }
			: undefined,
	);
	const agent = new AcpAgent(conn);
	await agent.authenticate({ methodId: "openai-codex" });
	vi.stubEnv("CLINE_QB_PROVIDER", "anthropic");
	await expect(
		agent.newSession({ cwd: "/tmp", mcpServers: [] }),
	).rejects.toThrow(/direct model provider/i);
	expect(calls.models).not.toHaveBeenCalled();
});

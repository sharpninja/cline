// SPDX-License-Identifier: Apache-2.0
/** TEST-QB-013/014: host construction policy survives session and delegated rebuilds. */
import { AgentRuntime } from "@cline/agents";
import type {
	AgentConfig,
	AgentModel,
	AgentRuntimeConfig,
} from "@cline/shared";
import { describe, expect, it, vi } from "vitest";
import {
	buildDelegatedAgentConfig,
	createDelegatedAgentConfigProvider,
} from "../../extensions/tools/team/delegated-agent";
import { DefaultRuntimeBuilder } from "../orchestration/runtime-builder";
import { SessionRuntime } from "../orchestration/session-runtime-orchestrator";

const base = {
	providerId: "anthropic",
	modelId: "claude-sonnet-4-5",
	apiKey: "synthetic",
	systemPrompt: "Test",
	tools: [],
};
function runtime(config: AgentConfig) {
	const stream = vi.fn(async function* () {
		yield { type: "text-delta" as const, text: "Not blocked" };
		yield { type: "finish" as const, reason: "stop" as const };
	});
	const session = new SessionRuntime(config, {
		createAgentRuntimeImpl: (candidate) =>
			new AgentRuntime({ ...candidate, model: { stream } as AgentModel }),
	});
	return { session, stream };
}
const block = (candidate: AgentRuntimeConfig): AgentRuntimeConfig => ({
	...candidate,
	modelRequestGate: () => ({
		outcome: "blocked",
		diagnostic: "Host policy unavailable",
	}),
});

describe("host runtime configuration", () => {
	it("runs captured host policy after optional setup on each fresh runtime, including restore", async () => {
		const configureAgentRuntime = vi.fn(block);
		const config = { ...base, configureAgentRuntime };
		const { session, stream } = runtime(config);
		config.configureAgentRuntime = vi.fn((candidate) => candidate);
		expect((await session.run("First")).finishReason).toBe("error");
		session.restore([]);
		expect((await session.run("Second")).finishReason).toBe("error");
		expect(configureAgentRuntime).toHaveBeenCalledTimes(2);
		expect(stream).not.toHaveBeenCalled();
		for (const [candidate] of configureAgentRuntime.mock.calls)
			expect(candidate.agentId).toBe(session.getAgentId());
	});
	it("host configuration failure prevents runtime construction", async () => {
		const construct = vi.fn();
		const session = new SessionRuntime(
			{
				...base,
				configureAgentRuntime: () => {
					throw new Error("Host unavailable");
				},
			},
			{ createAgentRuntimeImpl: construct },
		);
		await expect(session.run("Work")).rejects.toThrow("Host unavailable");
		expect(session.canStartRun()).toBe(true);
		expect(construct).not.toHaveBeenCalled();
	});
	it.each([
		"subagent",
		"teammate",
	] as const)("inherits factory without reusing agent state for %s", async (kind) => {
		const configureAgentRuntime = vi.fn(block);
		const configProvider = createDelegatedAgentConfigProvider({
			...base,
			sessionId: "root-session",
			configureAgentRuntime,
		});
		const first = runtime(
			buildDelegatedAgentConfig({
				kind,
				prompt: "Work",
				tools: [],
				configProvider,
				parentAgentId: "lead",
			}),
		);
		const second = runtime(
			buildDelegatedAgentConfig({
				kind,
				prompt: "Work",
				tools: [],
				configProvider,
				parentAgentId: "lead",
			}),
		);
		expect((await first.session.run("First")).finishReason).toBe("error");
		expect((await second.session.run("Second")).finishReason).toBe("error");
		expect(configureAgentRuntime).toHaveBeenCalledTimes(2);
		const configs = configureAgentRuntime.mock.calls.map(([config]) => config);
		expect(configs[0].agentId).not.toBe(configs[1].agentId);
		for (const config of configs)
			expect(config).toMatchObject({
				sessionId: "root-session",
				parentAgentId: "lead",
			});
		expect(first.stream).not.toHaveBeenCalled();
		expect(second.stream).not.toHaveBeenCalled();
	});
	it("cancellation during asynchronous host setup prevents provider dispatch", async () => {
		let entered!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let release!: () => void;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { session, stream } = runtime({
			...base,
			configureAgentRuntime: async (config) => {
				entered();
				await pending;
				return config;
			},
		});
		const run = session.run("Work");
		await started;
		session.abort("Operator canceled during setup");
		release();
		expect((await run).finishReason).toBe("aborted");
		expect(stream).not.toHaveBeenCalled();
		expect(session.canStartRun()).toBe(true);
	});
	it("a failed host setup releases admission for a subsequent successful run", async () => {
		let attempts = 0;
		const { session, stream } = runtime({
			...base,
			configureAgentRuntime: (config) => {
				if (++attempts === 1) throw new Error("Host unavailable");
				return config;
			},
		});
		await expect(session.run("First")).rejects.toThrow("Host unavailable");
		expect((await session.run("Second")).finishReason).toBe("completed");
		expect(attempts).toBe(2);
		expect(stream).toHaveBeenCalledTimes(1);
	});
	it("default builder forwards host policy even when tools, spawning and teams are disabled", async () => {
		const configureAgentRuntime = vi.fn(block);
		const built = await new DefaultRuntimeBuilder().build({
			config: {
				...base,
				cwd: process.cwd(),
				sessionId: "root-session",
				enableTools: false,
				enableSpawnAgent: false,
				enableAgentTeams: false,
			},
			configExtensions: [],
			configureAgentRuntime,
		});
		try {
			expect(
				built.delegatedAgentConfigProvider?.getRuntimeConfig()
					.configureAgentRuntime,
			).toBe(configureAgentRuntime);
		} finally {
			await built.shutdown("test");
		}
	});
});

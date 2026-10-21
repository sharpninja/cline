// SPDX-License-Identifier: Apache-2.0
/** TEST-QB-013/014: host workspace attribution survives agent construction. */
import {
	AgentRuntime,
	type AgentRuntimeConfig as RuntimeConstructorConfig,
} from "@cline/agents";
import type { AgentConfig, AgentRuntimeConfig } from "@cline/shared";
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
type Factory = NonNullable<AgentConfig["configureAgentRuntime"]>;
const block = (config: AgentRuntimeConfig): AgentRuntimeConfig => ({
	...config,
	modelRequestGate: () => ({
		outcome: "blocked",
		diagnostic: "Policy unavailable",
	}),
});
function session(config: AgentConfig) {
	const construct = vi.fn(
		(candidate: RuntimeConstructorConfig) =>
			new AgentRuntime({
				...candidate,
				model: {
					async *stream() {
						yield { type: "finish", reason: "stop" };
					},
				},
			}),
	);
	return {
		runtime: new SessionRuntime(config, { createAgentRuntimeImpl: construct }),
		construct,
	};
}
describe("trusted runtime workspace", () => {
	it("separates concurrent sessions without deriving workspace from process cwd", async () => {
		const configureAgentRuntime = vi.fn<Factory>(block);
		const first = session({
			...base,
			cwd: "/projects/first/sub",
			workspaceRoot: "/projects/first",
			sessionId: "first",
			configureAgentRuntime,
		});
		const second = session({
			...base,
			cwd: "/projects/second/sub",
			workspaceRoot: "/projects/second",
			sessionId: "second",
			configureAgentRuntime,
		});
		await Promise.all([
			first.runtime.run("First"),
			second.runtime.run("Second"),
		]);
		const seen = new Map(
			configureAgentRuntime.mock.calls.map(([config, workspace]) => [
				config.sessionId,
				workspace,
			]),
		);
		expect(seen.get("first")).toEqual({
			cwd: "/projects/first/sub",
			workspaceRoot: "/projects/first",
		});
		expect(seen.get("second")).toEqual({
			cwd: "/projects/second/sub",
			workspaceRoot: "/projects/second",
		});
	});
	it("captures immutable host workspace before caller mutation and retains it on restore", async () => {
		const configureAgentRuntime = vi.fn<Factory>((config, workspace) => {
			expect(Object.isFrozen(workspace)).toBe(true);
			expect(() => {
				(workspace as { cwd?: string }).cwd = "/spoof";
			}).toThrow();
			return block(config);
		});
		const config = {
			...base,
			cwd: "/actual/sub",
			workspaceRoot: "/actual",
			configureAgentRuntime,
		};
		const { runtime } = session(config);
		config.cwd = "/mutated";
		config.workspaceRoot = "/mutated";
		await runtime.run("First");
		runtime.restore([]);
		await runtime.run("Restored");
		expect(configureAgentRuntime).toHaveBeenCalledTimes(2);
		for (const [, workspace] of configureAgentRuntime.mock.calls)
			expect(workspace).toEqual({
				cwd: "/actual/sub",
				workspaceRoot: "/actual",
			});
	});
	it("leaves missing workspace explicit so a required factory can refuse before runtime construction", async () => {
		const configureAgentRuntime = vi.fn<Factory>((config, workspace) => {
			expect(workspace).toEqual({ cwd: undefined, workspaceRoot: undefined });
			if (!workspace.cwd) throw new Error("Host workspace missing");
			return config;
		});
		const { runtime, construct } = session({ ...base, configureAgentRuntime });
		await expect(runtime.run("Work")).rejects.toThrow("Host workspace missing");
		expect(construct).not.toHaveBeenCalled();
		expect(runtime.canStartRun()).toBe(true);
	});
	it.each([
		"subagent",
		"teammate",
	] as const)("attributes %s to its root session and actual working directory", async (kind) => {
		const configureAgentRuntime = vi.fn<Factory>(block);
		const configProvider = createDelegatedAgentConfigProvider({
			...base,
			cwd: "/repo/working",
			workspaceRoot: "/repo",
			sessionId: "root-session",
			configureAgentRuntime,
		});
		const { runtime } = session(
			buildDelegatedAgentConfig({
				kind,
				prompt: "Work",
				tools: [],
				parentAgentId: "lead",
				configProvider,
			}),
		);
		await runtime.run("Work");
		expect(configureAgentRuntime).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: "root-session",
				parentAgentId: "lead",
				agentId: runtime.getAgentId(),
			}),
			{ cwd: "/repo/working", workspaceRoot: "/repo" },
		);
	});
	it("preserves an explicit delegated working directory and its configured project root", async () => {
		const configureAgentRuntime = vi.fn<Factory>(block);
		const configProvider = createDelegatedAgentConfigProvider({
			...base,
			cwd: "/repo/default",
			workspaceRoot: "/repo",
			configureAgentRuntime,
		});
		const { runtime } = session(
			buildDelegatedAgentConfig({
				kind: "subagent",
				prompt: "Work",
				tools: [],
				configProvider,
				cwd: "/repo/selected",
			}),
		);
		await runtime.run("Work");
		expect(configureAgentRuntime.mock.calls[0][1]).toEqual({
			cwd: "/repo/selected",
			workspaceRoot: "/repo",
		});
	});
	it("cannot replace captured delegated host binding through returned config or connection updates", () => {
		const configureAgentRuntime = vi.fn<Factory>(block);
		const provider = createDelegatedAgentConfigProvider({
			...base,
			cwd: "/repo",
			workspaceRoot: "/repo",
			sessionId: "root",
			configureAgentRuntime,
		});
		const observed = provider.getRuntimeConfig();
		observed.cwd = "/spoof";
		observed.sessionId = "other";
		observed.configureAgentRuntime = undefined;
		provider.updateConnectionDefaults({
			modelId: "new-model",
			cwd: "/spoof",
			sessionId: "other",
			configureAgentRuntime: undefined,
		} as Parameters<typeof provider.updateConnectionDefaults>[0]);
		expect(provider.getRuntimeConfig()).toMatchObject({
			modelId: "new-model",
			cwd: "/repo",
			workspaceRoot: "/repo",
			sessionId: "root",
			configureAgentRuntime,
		});
	});
	it("default builder forwards working directory and distinct project root to delegated agents", async () => {
		const built = await new DefaultRuntimeBuilder().build({
			config: {
				...base,
				cwd: process.cwd(),
				workspaceRoot: "/configured/root",
				sessionId: "root",
				enableTools: false,
				enableSpawnAgent: false,
				enableAgentTeams: false,
			},
			configExtensions: [],
		});
		try {
			expect(
				built.delegatedAgentConfigProvider?.getRuntimeConfig(),
			).toMatchObject({
				cwd: process.cwd(),
				workspaceRoot: "/configured/root",
				sessionId: "root",
			});
		} finally {
			await built.shutdown("test");
		}
	});
});

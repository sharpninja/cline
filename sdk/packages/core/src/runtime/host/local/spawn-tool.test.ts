// SPDX-License-Identifier: Apache-2.0
/** TEST-QB-013/014: fallback and nested spawn retain host policy attribution. */
import type { AgentConfig, AgentRuntimeConfig, AgentTool } from "@cline/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { configs } = vi.hoisted(() => ({ configs: [] as AgentConfig[] }));
vi.mock("../../orchestration/session-runtime-orchestrator", () => ({
	SessionRuntime: class {
		constructor(config: AgentConfig) {
			configs.push(config);
		}
		getAgentId() {
			return "child";
		}
		getConversationId() {
			return "child-conversation";
		}
		subscribeEvents() {
			return () => {};
		}
		async run() {
			return {
				text: "Done",
				iterations: 1,
				finishReason: "completed",
				usage: { inputTokens: 0, outputTokens: 0 },
			};
		}
	},
}));

import { createSessionSpawnTool, type SpawnToolDeps } from "./spawn-tool";

const factory = (config: AgentRuntimeConfig) => config;
const config = {
	providerId: "anthropic",
	modelId: "test",
	cwd: "/actual/sub",
	workspaceRoot: "/actual",
	systemPrompt: "Test",
	enableAgentTeams: false,
	enableTools: false,
	enableSpawnAgent: true,
};
function deps(present: boolean): SpawnToolDeps {
	const delegatedAgentConfigProvider = {
		getRuntimeConfig: () => ({
			providerId: "anthropic",
			modelId: "new-model",
			cwd: "/spoof",
			workspaceRoot: "/spoof",
			sessionId: "foreign",
			configureAgentRuntime: undefined,
		}),
		getConnectionConfig: () => ({
			providerId: "anthropic",
			modelId: "new-model",
		}),
		updateConnectionDefaults: () => {},
	};
	return {
		configureAgentRuntime: factory,
		getSession: () =>
			present
				? ({
						runtime: { delegatedAgentConfigProvider },
					} as unknown as ReturnType<SpawnToolDeps["getSession"]>)
				: undefined,
		subAgentStarts: new Map(),
		onAgentEvent: vi.fn(),
		invokeBackendOptional: vi.fn(async () => {}),
	};
}
describe("session spawn host binding", () => {
	beforeEach(() => {
		configs.length = 0;
	});
	it.each([
		false,
		true,
	])("preserves captured factory and workspace with live provider=%s", async (present) => {
		const dependencies = deps(present);
		const tool = createSessionSpawnTool(dependencies, config, "root");
		dependencies.configureAgentRuntime = undefined;
		await tool.execute(
			{ systemPrompt: "Work", task: "Task" },
			{ agentId: "lead", iteration: 1, toolCallId: "spawn" },
		);
		expect(configs[0]).toMatchObject({
			configureAgentRuntime: factory,
			sessionId: "root",
			parentAgentId: "lead",
			cwd: "/actual/sub",
			workspaceRoot: "/actual",
		});
	});
	it("propagates the same host binding through nested fallback spawning", async () => {
		const dependencies = deps(false);
		const tool = createSessionSpawnTool(dependencies, config, "root");
		dependencies.configureAgentRuntime = undefined;
		await tool.execute(
			{ systemPrompt: "Work", task: "Task" },
			{ agentId: "lead", iteration: 1 },
		);
		const nested = configs[0].tools.find(
			(t) => t.name === "spawn_agent",
		) as AgentTool;
		expect(nested).toBeDefined();
		await nested.execute(
			{ systemPrompt: "Nested", task: "Task" },
			{ agentId: "child", iteration: 1 },
		);
		expect(configs[1]).toMatchObject({
			configureAgentRuntime: factory,
			sessionId: "root",
			parentAgentId: "child",
			cwd: "/actual/sub",
			workspaceRoot: "/actual",
		});
	});
});

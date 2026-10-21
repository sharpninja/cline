// SPDX-License-Identifier: Apache-2.0
/** TEST-QB-007/013/014: actual seeded Core sessions preserve current ingress. */
import { AgentRuntime } from "@cline/agents";
import type { AgentModel, AgentRunLifecycleContext } from "@cline/shared";
import { describe, expect, it, vi } from "vitest";
import { SessionRuntime } from "./session-runtime-orchestrator";

function createSession(stop = false) {
	const seen: AgentRunLifecycleContext[] = [];
	const stream = vi.fn(async function* () {
		yield { type: "text-delta" as const, text: "done" };
		yield { type: "finish" as const, reason: "stop" as const };
	});
	const session = new SessionRuntime(
		{
			providerId: "anthropic",
			modelId: "claude-sonnet-4-5",
			apiKey: "synthetic",
			systemPrompt: "Fixture",
			tools: [],
			sessionId: "root-session",
			configureAgentRuntime: (config) => ({
				...config,
				hooks: {
					...config.hooks,
					beforeRun: async (context) => {
						seen.push(context);
						if (stop) return { stop: true, reason: "Fixture refusal" };
						return config.hooks?.beforeRun?.(context);
					},
				},
			}),
		},
		{
			createAgentRuntimeImpl: (config) =>
				new AgentRuntime({ ...config, model: { stream } as AgentModel }),
		},
	);
	return { session, seen, stream };
}

describe("Core seeded lifecycle input", () => {
	it("delivers current input on run, continue, restore and clear without duplicate messages", async () => {
		const { session, seen } = createSession();
		try {
			expect((await session.run(" \nfirst\t ")).finishReason).toBe("completed");
			expect((await session.continue("second")).finishReason).toBe("completed");
			expect((await session.continue()).finishReason).toBe("completed");
			session.restore([
				{
					role: "user",
					content: [{ type: "text", text: "old restored prompt" }],
				},
			]);
			expect((await session.continue("new restored prompt")).finishReason).toBe(
				"completed",
			);
			session.clearHistory();
			expect((await session.run("")).finishReason).toBe("completed");
			expect(seen.map((entry) => entry.input)).toEqual([
				" \nfirst\t ",
				"second",
				undefined,
				"new restored prompt",
				"",
			]);
			expect(
				seen.map(
					(entry) =>
						entry.snapshot.messages.filter((msg) => msg.role === "user").length,
				),
			).toEqual([1, 2, 2, 2, 1]);
			expect(
				session.getMessages().filter((msg) => msg.role === "user"),
			).toHaveLength(1);
			expect(new Set(seen.map((entry) => entry.snapshot.runId)).size).toBe(5);
			for (const entry of seen)
				expect(entry.snapshot.agentId).toBe(session.getAgentId());
		} finally {
			await session.shutdown();
		}
	});

	it("allows host refusal to observe the prompt while preventing model dispatch", async () => {
		const { session, seen, stream } = createSession(true);
		try {
			expect((await session.run("refused current prompt")).finishReason).toBe(
				"aborted",
			);
			expect(seen[0].input).toBe("refused current prompt");
			expect(stream).not.toHaveBeenCalled();
			expect(
				session.getMessages().filter((msg) => msg.role === "user"),
			).toHaveLength(1);
		} finally {
			await session.shutdown();
		}
	});

	it("keeps concurrent session inputs and agent attribution separate", async () => {
		const first = createSession();
		const second = createSession();
		try {
			await Promise.all([
				first.session.run("first-session"),
				second.session.run("second-session"),
			]);
			expect(first.seen.map((entry) => entry.input)).toEqual(["first-session"]);
			expect(second.seen.map((entry) => entry.input)).toEqual([
				"second-session",
			]);
			expect(first.seen[0].snapshot.agentId).not.toBe(
				second.seen[0].snapshot.agentId,
			);
		} finally {
			await first.session.shutdown();
			await second.session.shutdown();
		}
	});
});

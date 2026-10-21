// SPDX-License-Identifier: Apache-2.0
import type {
	AgentMessage,
	AgentModel,
	AgentModelEvent,
	AgentModelRequest,
	AgentRunLifecycleContext,
} from "@cline/shared";
import { describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "./agent-runtime";

function message(id: string, text: string): AgentMessage {
	return {
		id,
		role: "user",
		createdAt: 123,
		content: [{ type: "text", text }],
	};
}
function model(): AgentModel {
	return {
		stream: vi.fn(async function* (
			_request: AgentModelRequest,
		): AsyncIterable<AgentModelEvent> {
			yield { type: "text-delta", text: "done" };
			yield { type: "finish", reason: "stop" };
		}),
	};
}

describe("current invocation input at beforeRun", () => {
	it("observes pre-seeded input once and captures append options before asynchronous setup", async () => {
		const beforeRun = vi.fn();
		const optionalBeforeRun = vi.fn();
		const runtime = new AgentRuntime({
			model: model(),
			initialMessages: [message("seeded-id", "seeded")],
			hooks: { beforeRun },
			plugins: [
				{
					name: "observer",
					setup: () => ({ hooks: { beforeRun: optionalBeforeRun } }),
				},
			],
		});
		const options = { appendInput: false };
		const running = runtime.run("seeded", options);
		options.appendInput = true;
		expect((await running).status).toBe("completed");
		for (const observer of [beforeRun, optionalBeforeRun])
			expect(observer.mock.calls[0][0].input).toBe("seeded");
		expect(
			runtime.snapshot().messages.filter((entry) => entry.role === "user"),
		).toEqual([message("seeded-id", "seeded")]);
		await runtime.continue("next");
		expect(
			runtime.snapshot().messages.filter((entry) => entry.role === "user"),
		).toHaveLength(2);
	});
	it("preserves exact input across first run, continuation and restore with fresh run IDs", async () => {
		const seen: AgentRunLifecycleContext[] = [];
		const afterRun = vi.fn();
		const runtime = new AgentRuntime({
			model: model(),
			agentId: "child",
			parentAgentId: "parent",
			conversationId: "root-session",
			hooks: {
				beforeRun: (context) => {
					seen.push(context);
				},
				afterRun,
			},
		});
		await runtime.run(" \nfirst\t ");
		await runtime.continue("second");
		runtime.restore([message("history", "restored history")]);
		await runtime.run("third");
		expect(seen.map((context) => context.input)).toEqual([
			" \nfirst\t ",
			"second",
			"third",
		]);
		expect(seen[0].snapshot.messages).toEqual([]);
		expect(seen[1].snapshot.messages[0].content).toEqual([
			{ type: "text", text: " \nfirst\t " },
		]);
		expect(seen[2].snapshot.messages).toEqual([
			message("history", "restored history"),
		]);
		expect(new Set(seen.map((context) => context.snapshot.runId)).size).toBe(3);
		for (const context of seen)
			expect(context.snapshot).toMatchObject({
				agentId: "child",
				parentAgentId: "parent",
				conversationId: "root-session",
				status: "running",
			});
		for (const [context] of afterRun.mock.calls)
			expect(context).not.toHaveProperty("input");
	});

	it("distinguishes inputless continue from explicit empty string and empty message batch", async () => {
		const beforeRun = vi.fn();
		const runtime = new AgentRuntime({ model: model(), hooks: { beforeRun } });
		await runtime.run("old prompt");
		await runtime.continue();
		await runtime.continue("");
		await runtime.continue([]);
		expect(beforeRun.mock.calls.map(([context]) => context.input)).toEqual([
			"old prompt",
			undefined,
			"",
			[],
		]);
		expect(
			runtime
				.snapshot()
				.messages.filter((entry) => entry.role === "user")
				.map((entry) => entry.content),
		).toEqual([[{ type: "text", text: "old prompt" }]]);
	});

	it.each([
		false,
		true,
	])("preserves message IDs/order and input shape (batch=%s)", async (batch) => {
		const entries = [
			message("original-1", "first"),
			message("original-2", "second"),
		];
		const input = batch ? entries : entries[0];
		const beforeRun = vi.fn();
		const runtime = new AgentRuntime({ model: model(), hooks: { beforeRun } });
		await runtime.run(input);
		const observed = beforeRun.mock.calls[0][0].input;
		expect(observed).toEqual(input);
		expect(observed).not.toBe(input);
		expect(Array.isArray(observed)).toBe(batch);
		expect(
			runtime.snapshot().messages.filter((entry) => entry.role === "user"),
		).toEqual(batch ? entries : [entries[0]]);
	});

	it("captures before async plugin setup and isolates caller, each hook and provider data", async () => {
		let releaseSetup!: () => void;
		const setupGate = new Promise<void>((resolve) => {
			releaseSetup = resolve;
		});
		let setupEntered!: () => void;
		const entered = new Promise<void>((resolve) => {
			setupEntered = resolve;
		});
		const bytes = new Uint8Array([1, 2]);
		const buffer = new Uint8Array([3, 4]).buffer;
		const url = new URL("https://example.test/original.png");
		const input: AgentMessage = {
			...message("current-id", "original"),
			metadata: { nested: { rootId: "root-id" }, at: new Date(123) },
			content: [
				{ type: "image", image: bytes },
				{ type: "image", image: buffer },
				{ type: "image", image: url },
				{
					type: "tool-call",
					toolName: "fixture",
					toolCallId: "call-id",
					input: { nested: { value: "original" } },
				},
			],
		};
		let retained!: AgentMessage;
		const observer = vi.fn();
		const source = model();
		const runtime = new AgentRuntime({
			model: source,
			hooks: {
				beforeRun: (context) => {
					retained = context.input as AgentMessage;
					(retained.metadata?.nested as { rootId: string }).rootId =
						"hook-forged";
					const part = retained.content[0];
					if (part.type === "image" && part.image instanceof Uint8Array)
						part.image[0] = 9;
					retained.content.length = 0;
				},
			},
			plugins: [
				{
					name: "observer",
					setup: async () => {
						setupEntered();
						await setupGate;
						return { hooks: { beforeRun: observer } };
					},
				},
			],
		});
		const pending = runtime.run(input);
		await entered;
		input.id = "caller-forged";
		(input.metadata?.nested as { rootId: string }).rootId = "caller-forged";
		bytes[0] = 8;
		new Uint8Array(buffer)[0] = 8;
		url.pathname = "/forged";
		releaseSetup();
		expect((await pending).status).toBe("completed");
		const observed = observer.mock.calls[0][0].input as AgentMessage;
		expect(observed.id).toBe("current-id");
		expect(observed.metadata).toEqual({
			nested: { rootId: "root-id" },
			at: new Date(123),
		});
		expect(observed.content).toEqual([
			{ type: "image", image: new Uint8Array([1, 2]) },
			{ type: "image", image: new Uint8Array([3, 4]).buffer },
			{ type: "image", image: new URL("https://example.test/original.png") },
			{
				type: "tool-call",
				toolName: "fixture",
				toolCallId: "call-id",
				input: { nested: { value: "original" } },
			},
		]);
		expect(vi.mocked(source.stream).mock.calls[0][0].messages[0]).toEqual(
			observed,
		);
		observed.content.length = 0;
		retained.id = "late-hook-forged";
		expect(runtime.snapshot().messages[0].id).toBe("current-id");
		expect(runtime.snapshot().messages[0].content).toHaveLength(4);
	});

	it("makes input available to refusing hooks without dispatching or appending it", async () => {
		const source = model();
		const beforeRun = vi.fn(() => ({ stop: true, reason: "fixture refusal" }));
		const runtime = new AgentRuntime({ model: source, hooks: { beforeRun } });
		expect((await runtime.run("must audit refusal")).status).toBe("aborted");
		expect(beforeRun).toHaveBeenCalledWith(
			expect.objectContaining({ input: "must audit refusal" }),
		);
		expect(source.stream).not.toHaveBeenCalled();
		expect(runtime.snapshot().messages).toEqual([]);
	});

	it.each([
		() => undefined,
		Symbol("not-data"),
		new Map(),
	])("refuses unsupported input data before initialization or model side effects (%s)", async (value) => {
		const source = model();
		const setup = vi.fn();
		const runtime = new AgentRuntime({
			model: source,
			plugins: [{ name: "fixture", setup }],
		});
		await expect(
			runtime.run({ ...message("id", "prompt"), metadata: { value } }),
		).rejects.toThrow(
			/Request contains executable data|Unsupported model request data/,
		);
		expect(setup).not.toHaveBeenCalled();
		expect(source.stream).not.toHaveBeenCalled();
		expect(runtime.snapshot().status).toBe("idle");
		expect((await runtime.run("valid retry")).status).toBe("completed");
	});
});

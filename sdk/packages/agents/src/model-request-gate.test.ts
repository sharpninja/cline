// SPDX-License-Identifier: Apache-2.0
/** TEST-QB-002/004/006: host authorization at the actual provider request boundary. */
import type {
	AgentModel,
	AgentModelRequest,
	AgentRuntimeConfig,
} from "@cline/shared";
import { describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "./agent-runtime";

const model = (): AgentModel => ({
	stream: vi.fn(async function* () {
		yield { type: "text-delta", text: "Done" };
		yield { type: "finish", reason: "stop" };
	}),
});
type Gate = NonNullable<AgentRuntimeConfig["modelRequestGate"]>;
const allow: Gate = ({ request }) => ({ outcome: "allow", request });

describe("mandatory final model request gate", () => {
	it("restores required guidance and tools after all optional request rewriting", async () => {
		const source = model();
		const order: string[] = [];
		const runtime = new AgentRuntime({
			model: source,
			prepareTurn: () => {
				order.push("prepare");
				return { messages: [] };
			},
			hooks: {
				beforeModel: () => {
					order.push("hook");
					return { messages: [], tools: [], options: { weakened: true } };
				},
			},
			modelRequestGate: ({ request }) => {
				order.push("gate");
				return {
					outcome: "allow",
					request: {
						...request,
						messages: [
							{
								id: "required",
								role: "user",
								createdAt: 1,
								content: [{ type: "text", text: "REQUIRED" }],
							},
						],
						tools: [
							{
								name: "required",
								description: "required",
								inputSchema: { type: "object" },
							},
						],
						options: { safe: true },
					},
				};
			},
		});
		expect((await runtime.run("Work")).status).toBe("completed");
		expect(order).toEqual(["prepare", "hook", "gate"]);
		expect(
			Object.getPrototypeOf(vi.mocked(source.stream).mock.calls[0][0].options),
		).toBe(Object.prototype);
		expect(vi.mocked(source.stream).mock.calls[0][0]).toMatchObject({
			messages: [{ id: "required" }],
			tools: [{ name: "required" }],
			options: { safe: true },
		});
		expect(
			vi.mocked(source.stream).mock.calls[0][0].options,
		).not.toHaveProperty("weakened");
	});
	it.each([
		"blocked",
		"throw",
		"missing-decision",
		"missing-request",
		"bad-messages",
		"bad-tools",
	])("blocks %s without calling provider", async (kind) => {
		const source = model();
		const events: unknown[] = [];
		const gate = (({ request }: Parameters<Gate>[0]) => {
			if (kind === "throw") throw new Error("private infrastructure detail");
			if (kind === "missing-decision") return undefined;
			if (kind === "missing-request") return { outcome: "allow" };
			if (kind === "bad-messages")
				return {
					outcome: "allow",
					request: { ...request, messages: undefined },
				};
			if (kind === "bad-tools")
				return { outcome: "allow", request: { ...request, tools: undefined } };
			return { outcome: "blocked", diagnostic: "Restore required governance" };
		}) as Gate;
		const runtime = new AgentRuntime({ model: source, modelRequestGate: gate });
		runtime.subscribe((event) => {
			events.push(event);
		});
		expect((await runtime.run("Work")).status).toBe("blocked");
		expect(source.stream).not.toHaveBeenCalled();
		expect(JSON.stringify(events)).not.toContain(
			"private infrastructure detail",
		);
		expect(events).not.toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "assistant-text-delta" }),
			]),
		);
	});
	it("captures the host gate even when caller configuration changes", async () => {
		const source = model();
		const gate = vi.fn<Gate>(() => ({
			outcome: "blocked",
			diagnostic: "Required",
		}));
		const config: AgentRuntimeConfig = {
			model: source,
			modelRequestGate: gate,
		};
		const runtime = new AgentRuntime(config);
		config.modelRequestGate = allow;
		expect((await runtime.run("Work")).status).toBe("blocked");
		expect(gate).toHaveBeenCalledOnce();
	});
	it("detaches optional-hook retained inputs before an awaited host check", async () => {
		let retained!: AgentModelRequest;
		let release!: () => void;
		let entered!: () => void;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		const ready = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const source = model();
		const runtime = new AgentRuntime({
			model: source,
			hooks: {
				beforeModel: ({ request }) => {
					retained = request;
				},
			},
			modelRequestGate: async ({ request }) => {
				entered();
				await pending;
				return { outcome: "allow", request };
			},
		});
		const running = runtime.run("Original");
		await ready;
		(retained.messages[0].content[0] as { text: string }).text = "MUTATED";
		release();
		expect((await running).status).toBe("completed");
		expect(
			JSON.stringify(vi.mocked(source.stream).mock.calls[0][0]),
		).not.toContain("MUTATED");
	});
	it("preserves detached binary and URL images", async () => {
		const source = model();
		const bytes = new Uint8Array([1, 2, 3]);
		const url = new URL("https://example.test/image.png");
		const runtime = new AgentRuntime({
			model: source,
			modelRequestGate: allow,
		});
		await runtime.run([
			{
				id: "image",
				role: "user",
				createdAt: 1,
				content: [
					{ type: "image", image: bytes },
					{ type: "image", image: url },
				],
			},
		]);
		const request = vi.mocked(source.stream).mock.calls[0][0];
		const parts = request.messages[0].content as Array<{
			image: Uint8Array | URL;
		}>;
		expect(parts[0].image).toEqual(bytes);
		expect(parts[0].image).not.toBe(bytes);
		expect(parts[1].image).toBeInstanceOf(URL);
		expect(String(parts[1].image)).toBe(String(url));
	});
	it("rechecks on continuation requests and refuses the second provider call", async () => {
		const source: AgentModel = {
			stream: vi.fn(async function* () {
				yield { type: "text-delta", text: "Partial" };
				yield { type: "finish", reason: "unknown" };
			}),
		};
		let count = 0;
		const runtime = new AgentRuntime({
			model: source,
			modelRequestGate: (context) =>
				++count === 1
					? allow(context)
					: { outcome: "blocked", diagnostic: "Trust expired" },
		});
		expect((await runtime.run("Work")).status).toBe("blocked");
		expect(count).toBe(2);
		expect(source.stream).toHaveBeenCalledOnce();
	});
	it.each([
		"allow",
		"blocked",
	])("honors cancellation while the gate waits, even with %s decision", async (outcome) => {
		let release!: () => void;
		let entered!: () => void;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		const ready = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const source = model();
		const runtime = new AgentRuntime({
			model: source,
			modelRequestGate: async (context) => {
				entered();
				await pending;
				return outcome === "allow"
					? allow(context)
					: { outcome: "blocked", diagnostic: "Trust expired" };
			},
		});
		const running = runtime.run("Work");
		await ready;
		runtime.abort();
		release();
		expect((await running).status).toBe("aborted");
		expect(source.stream).not.toHaveBeenCalled();
	});
});

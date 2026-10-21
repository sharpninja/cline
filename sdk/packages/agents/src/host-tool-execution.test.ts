// SPDX-License-Identifier: Apache-2.0
/** TEST-QB-002/004: host-only execution must be enforced by the actual adapter. */
import type { AgentModel, AgentModelRequest } from "@cline/shared";
import { describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "./agent-runtime";

describe("host-only model tool execution", () => {
	it.each([
		undefined,
		false,
		"true",
	])("refuses unproven adapter capability %s", async (capability) => {
		const stream = vi.fn(async function* () {
			yield { type: "text-delta" as const, text: "Forbidden" };
			yield { type: "finish" as const, reason: "stop" as const };
		});
		const model = {
			enforcesHostToolExecution: capability,
			stream,
		} as AgentModel;
		const runtime = new AgentRuntime({
			model,
			modelRequestGate: ({ request }) => ({
				outcome: "allow",
				request: { ...request, toolExecutionPolicy: "host-only" },
			}),
		});
		expect((await runtime.run("Work")).status).toBe("blocked");
		expect(stream).not.toHaveBeenCalled();
	});
	it("preserves host execution policy through request cloning and every dispatch", async () => {
		const requests: AgentModelRequest[] = [];
		const model: AgentModel = {
			enforcesHostToolExecution: true,
			async *stream(request) {
				requests.push(request);
				yield { type: "text-delta", text: "Done" };
				yield { type: "finish", reason: "stop" };
			},
		};
		const runtime = new AgentRuntime({
			model,
			modelRequestGate: ({ request }) => ({
				outcome: "allow",
				request: { ...request, toolExecutionPolicy: "host-only" },
			}),
		});
		await runtime.run("First");
		runtime.restore([]);
		await runtime.run("Second");
		expect(requests).toHaveLength(2);
		expect(requests.every((r) => r.toolExecutionPolicy === "host-only")).toBe(
			true,
		);
	});
	it("rejects provider-executed tools even for a capable custom adapter", async () => {
		const stream = vi.fn(async function* () {
			yield { type: "finish" as const, reason: "stop" as const };
		});
		const runtime = new AgentRuntime({
			model: { enforcesHostToolExecution: true, stream },
			modelRequestGate: ({ request }) => ({
				outcome: "allow",
				request: {
					...request,
					toolExecutionPolicy: "host-only",
					modelTools: [{ name: "web_search" }],
				},
			}),
		});
		expect((await runtime.run("Work")).status).toBe("blocked");
		expect(stream).not.toHaveBeenCalled();
	});
	it("binds capability to the adapter captured before asynchronous authorization", async () => {
		const stream = vi.fn(async function* () {
			yield { type: "text-delta" as const, text: "Forbidden" };
			yield { type: "finish" as const, reason: "stop" as const };
		});
		const model = { enforcesHostToolExecution: false, stream };
		const runtime = new AgentRuntime({
			model,
			modelRequestGate: async ({ request }) => {
				await Promise.resolve();
				model.enforcesHostToolExecution = true;
				return {
					outcome: "allow",
					request: { ...request, toolExecutionPolicy: "host-only" },
				};
			},
		});
		expect((await runtime.run("Work")).status).toBe("blocked");
		expect(stream).not.toHaveBeenCalled();
	});
	it("keeps generic ungoverned adapters working without a declaration", async () => {
		const model: AgentModel = {
			async *stream() {
				yield { type: "text-delta", text: "Done" };
				yield { type: "finish", reason: "stop" };
			},
		};
		expect((await new AgentRuntime({ model }).run("Work")).status).toBe(
			"completed",
		);
	});
});

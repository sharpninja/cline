// SPDX-License-Identifier: Apache-2.0
/** Independent test-only receipt boundary, not a runtime mechanism.
 * It receives operations and inputs only. It cannot read a scenario's expected
 * observations. Plugin replies, journal state and captured effects are separate.
 * Later real adapters must keep assertScenario and capture real interactions. */
import assert from "node:assert/strict";
import type { ContractDriver } from "../p1-contract-mock.test";

type Data = Record<string, unknown>;
export type RevisionFault =
	| "accept-nonpositive"
	| "lose-retained"
	| "wrong-response"
	| "missing-response"
	| "reordered-callback"
	| "missing-callback"
	| "omit-effect";
const fields = [
	"workspaceId",
	"agentIdentity",
	"mcpSessionId",
	"requestId",
	"eventId",
	"order",
	"method",
	"payloadHash",
	"serverRevision",
];
const root = {
	workspaceId: "fixture-workspace-a",
	agentIdentity: "ClineQb",
	mcpSessionId: "fixture-session-a",
	requestId: "fixture-request-a",
};
const object = (value: unknown): Data => {
	assert.ok(
		value !== null && typeof value === "object",
		"Required dependency response omitted",
	);
	return value as Data;
};

/** Scripted transport owns callback delivery, not the governance decision.
 * Scripts are raw replies taken from scenario INPUTS, never expected outputs. */
class ReceiptPluginFake {
	readonly requests: { method: string; input: Data; reply: unknown }[] = [];
	readonly trace: unknown[] = [];
	private readonly requiredTrace: unknown[] = [];
	private ordinal = 0;
	constructor(
		private readonly fault?: RevisionFault,
		private readonly faultAt = 0,
	) {}
	call(method: string, input: Data, scriptedReply: Data): Data {
		const ordinal = this.ordinal++;
		const request = { kind: "request", method, input: structuredClone(input) };
		const callback = {
			kind: "callback",
			method,
			reply: structuredClone(scriptedReply),
		};
		this.requiredTrace.push(request, callback);
		let reply: unknown = structuredClone(scriptedReply);
		const injected = ordinal === this.faultAt;
		if (injected && this.fault === "wrong-response")
			reply = { ...scriptedReply, serverRevision: -99, available: false };
		if (injected && this.fault === "missing-response") reply = undefined;
		const actualCallback = {
			kind: "callback",
			method,
			reply: structuredClone(reply),
		};
		if (injected && this.fault === "reordered-callback")
			this.trace.push(actualCallback, request);
		else {
			this.trace.push(request);
			if (!(injected && this.fault === "missing-callback"))
				this.trace.push(actualCallback);
		}
		this.requests.push({
			method,
			input: structuredClone(input),
			reply: structuredClone(reply),
		});
		return object(reply);
	}
	finish(): void {
		assert.deepStrictEqual(
			this.trace,
			this.requiredTrace,
			"Dependency response/callback sequence differs",
		);
	}
}

export class ReceiptRevisionFake implements ContractDriver {
	readonly calls: ContractDriver["calls"] = [];
	readonly effects: { target: string; payload: unknown }[] = [];
	readonly plugin: ReceiptPluginFake;
	readonly journal = new Map<string, Data>();
	private readonly requiredEffects: { target: string; payload: unknown }[] = [];
	constructor(
		private readonly fault?: RevisionFault,
		faultAt = 0,
	) {
		this.plugin = new ReceiptPluginFake(fault, faultAt);
	}
	private emit(target: string, payload: unknown): void {
		const effect = { target, payload: structuredClone(payload) };
		this.requiredEffects.push(effect);
		if (!(this.fault === "omit-effect" && this.effects.length === 0))
			this.effects.push(structuredClone(effect));
	}
	private count(target: string): number {
		return this.effects.filter((effect) => effect.target === target).length;
	}
	async invoke(operation: string, input: Data): Promise<unknown> {
		this.calls.push({ operation, input: structuredClone(input) });
		if (operation === "afterTool") {
			const unchanged = input.code === "unchanged";
			const event = object(input.expected);
			const raw = object(unchanged ? input.receipt : input.transport);
			const key = String(event.eventId);
			this.journal.set(key, structuredClone(event));
			this.emit("retained-evidence", event);
			const reply = this.plugin.call(
				unchanged ? "plugin.getPersistedEvent" : "plugin.afterTool.submitEvent",
				{ event: structuredClone(event) },
				unchanged
					? {
							...raw,
							code: "unchanged",
							matchingReadback: input.matchingReadback,
						}
					: raw,
			);
			const positive =
				this.fault === "accept-nonpositive" ||
				(typeof reply.serverRevision === "number" && reply.serverRevision > 0);
			const confirmed =
				positive &&
				fields.every((field) => reply[field] === event[field]) &&
				(unchanged
					? reply.code === "unchanged" && reply.matchingReadback === true
					: reply.code === "persisted");
			if (confirmed) {
				this.journal.delete(key);
				const { matchingReadback: _readback, ...receipt } = reply;
				this.emit(unchanged ? "verified-readback" : "audit", receipt);
				this.emit("retirement", { eventId: key });
				return unchanged
					? { confirmed: true, receipt }
					: {
							confirmed: true,
							receipt,
							mandatoryOutstanding: this.journal.size,
						};
			}
			if (this.fault === "lose-retained") this.journal.clear();
			return unchanged
				? { confirmed: false }
				: { confirmed: false, evidenceRetained: this.journal.size > 0 };
		}
		assert.equal(operation, "beforeCompletion", "Unexpected operation");
		const reply = this.plugin.call(
			"plugin.readCompletionEvidence",
			{ context: root },
			{
				available: true,
				pendingCount: input.pendingCount ?? 0,
			},
		);
		if (
			!reply.available ||
			this.journal.size > 0 ||
			Number(reply.pendingCount) > 0
		) {
			this.emit("diagnostic", { unresolved: true });
			this.emit("recovery", { supported: true });
			this.emit("retained-evidence", [...this.journal.values()]);
			return {
				outcome: "blocked",
				ordinaryExecutions: this.count("ordinary"),
				successEvents: this.count("success"),
				diagnosticsDeliverable: this.count("diagnostic") > 0,
				evidenceRetained: this.journal.size > 0,
				supportedRecovery: this.count("recovery") > 0,
			};
		}
		this.emit("success", { requestId: root.requestId });
		return {
			outcome: "complete",
			successEvents: this.count("success"),
			requestId: root.requestId,
		};
	}
	async finish(): Promise<void> {
		this.plugin.finish();
		assert.deepStrictEqual(
			this.effects,
			this.requiredEffects,
			"Required side effect omitted",
		);
		for (const effect of this.effects.filter(
			(value) => value.target === "retirement",
		)) {
			const eventId = object(effect.payload).eventId;
			assert.ok(
				this.effects.some(
					(value) =>
						(value.target === "audit" ||
							value.target === "verified-readback") &&
						object(value.payload).eventId === eventId,
				),
				"Retirement requires confirmed receipt",
			);
		}
	}
}

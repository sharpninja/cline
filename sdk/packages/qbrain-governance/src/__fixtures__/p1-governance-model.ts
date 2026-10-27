// SPDX-License-Identifier: Apache-2.0
/** Test-only behavioral model. No scenario, oracle, production or candidate imports.
 * Raw transport replies and callbacks are scripted below. The model consumes them
 * through the frozen gate operations; observations come from captured effects.
 */
import assert from "node:assert/strict";
import {
	type AuditHistoryFault,
	observeRequestHistory,
} from "./p1-request-history-model";

type Data = Record<string, unknown>;
const object = (value: unknown): Data =>
	value && typeof value === "object" ? (value as Data) : {};
const strings = (value: unknown): string[] =>
	Array.isArray(value) ? value.map(String) : [];
const identity = (value: unknown): Data => {
	const data = object(value);
	return Object.fromEntries(
		["workspaceId", "agentIdentity", "mcpSessionId", "requestId"].map((key) => [
			key,
			data[key],
		]),
	);
};
const initial = {
	workspaceId: "fixture-workspace-a",
	agentIdentity: "ClineQb",
	mcpSessionId: "fixture-session-a",
	requestId: "fixture-request-a",
};
const receiptFields = [
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
const transportReceipt = {
	...initial,
	eventId: "event-a",
	order: 7,
	method: "audit",
	payloadHash: "b".repeat(64),
	code: "persisted",
	serverRevision: 9,
};
const skills = [
	"reddit-publish",
	"reddit-draft",
	"commit-sync",
	"handoff",
	"clear-session",
];
export interface CapturedEffect {
	target: string;
	payload: unknown;
}
export type DependencyFault =
	| "wrong"
	| "omitted"
	| "reordered"
	| "callback-omitted"
	| "side-effect-omitted";
export interface BoundaryFault {
	step: number;
	kind: DependencyFault;
	dependencyIndex?: number;
}
export interface DependencyCapture {
	method: string;
	request: unknown;
	reply: unknown;
	acknowledged: boolean;
}

/** Independently scripted dependency conversation, not result-object fixtures.
 * Every callback and side effect is an interaction checked in finish().
 */
class Conversation {
	readonly calls: DependencyCapture[] = [];
	readonly effects: CapturedEffect[] = [];
	private next = 0;
	constructor(
		private readonly fault?: DependencyFault,
		private readonly faultIndex = 0,
	) {}
	exchange(method: string, request: unknown, reply: unknown): unknown {
		const ordinal = this.next++;
		const record: DependencyCapture = {
			method,
			request: structuredClone(request),
			reply: structuredClone(reply),
			acknowledged: false,
		};
		this.calls.push(record);
		if (ordinal === this.faultIndex && this.fault === "omitted")
			return undefined;
		if (ordinal === this.faultIndex && this.fault === "wrong")
			return { revision: -1, corruptedDependency: true };
		if (ordinal === this.faultIndex && this.fault === "reordered") {
			this.calls.push({
				...record,
				method: "callback-before-request",
				acknowledged: false,
			});
			return undefined;
		}
		record.acknowledged = !(
			ordinal === this.faultIndex && this.fault === "callback-omitted"
		);
		return structuredClone(reply);
	}
	read(method: string, request: unknown, reply: Data): Data {
		const received = object(
			this.exchange(method, request, { revision: 1, ...reply }),
		);
		assert.equal(
			received.revision,
			1,
			`Missing or invalid ${method} dependency revision`,
		);
		return received;
	}
	emit(target: string, payload: unknown): void {
		const acknowledgement = this.read(
			"effect.capture",
			{ target, payload },
			{ captured: true },
		);
		if (this.fault !== "side-effect-omitted" || this.effects.length > 0)
			this.effects.push({ target, payload: structuredClone(payload) });
		assert.equal(acknowledgement.captured, true);
	}
	finish(): void {
		assert.ok(
			this.calls.length > 0,
			"The operation must exercise a dependency boundary",
		);
		assert.ok(
			this.calls.every((call) => call.acknowledged),
			"Required dependency callback missing or out of order",
		);
		const writes = this.calls.filter(
			(call) => call.method === "effect.capture",
		);
		assert.equal(
			this.effects.length,
			writes.length,
			"An acknowledged side effect was not captured",
		);
	}
}

/** Models own request, journal, transport and completion state. Setup flags seed
 * dependency failures; they are not output selectors or case-name dispatch.
 */
export class GovernanceModel {
	readonly calls: { operation: string; input: Data }[] = [];
	readonly dependencies: DependencyCapture[] = [];
	readonly stepCaptures: {
		operation: string;
		dependencies: DependencyCapture[];
		effects: CapturedEffect[];
	}[] = [];
	readonly effects: CapturedEffect[] = [];
	private conversations: Conversation[] = [];
	private active: Data = { ...initial };
	private delivered = new Map<string, Data>();
	private minted = new Set<string>();
	private retained = new Map<string, Data>();
	private journal = new Map<string, Data>();
	private decisions = new Map<string, string>();
	private originalEvidence: Data | undefined;
	private replacementReady = false;
	private ordinary = 0;
	private success = 0;
	private attempts = 0;
	private fingerprint = "";
	private stepIndex = 0;
	constructor(
		private readonly fault?: BoundaryFault,
		private readonly historyFault?: AuditHistoryFault,
	) {}
	private count(conversation: Conversation, target: string): number {
		return conversation.effects.filter((effect) => effect.target === target)
			.length;
	}
	private blocked(c: Conversation): Data {
		c.emit("diagnostic", { reason: "protected obligation unresolved" });
		c.emit("recovery", { supported: true });
		c.emit("retained-evidence", { context: this.active, unresolved: true });
		return {
			outcome: "blocked",
			ordinaryExecutions: this.ordinary,
			successEvents: this.success,
			diagnosticsDeliverable: this.count(c, "diagnostic") > 0,
			evidenceRetained: this.count(c, "retained-evidence") > 0,
			supportedRecovery: this.count(c, "recovery") > 0,
		};
	}
	private complete(c: Conversation): Data {
		c.emit("success", { requestId: this.active.requestId });
		this.success++;
		return {
			outcome: "complete",
			successEvents: this.success,
			requestId: this.active.requestId,
		};
	}
	async invoke(operation: string, input: Data): Promise<unknown> {
		this.calls.push({ operation, input: structuredClone(input) });
		const c = new Conversation(
			this.fault?.step === this.stepIndex++ ? this.fault.kind : undefined,
			this.fault?.dependencyIndex ?? 0,
		);
		this.conversations.push(c);

		const result = this.dispatch(operation, input, c);
		this.dependencies.push(...c.calls);
		this.effects.push(...c.effects);
		this.stepCaptures.push({
			operation,
			dependencies: structuredClone(c.calls),
			effects: structuredClone(c.effects),
		});
		return result;
	}
	async finish(): Promise<void> {
		for (const c of this.conversations) c.finish();
	}
	private dispatch(operation: string, input: Data, c: Conversation): unknown {
		switch (operation) {
			case "startup":
				return this.startup(input, c);
			case "configure": {
				const protectedState = c.read(
					"plugin.readProtectedPolicy",
					{},
					{ digest: "policy-a", gate: true },
				);
				c.emit("configuration", {
					ignoredRemoval: input.surface,
					digest: protectedState.digest,
				});
				return {
					protectedPolicyPresent: Boolean(protectedState.digest),
					policyDigest: protectedState.digest,
					protectedGatePresent: protectedState.gate,
				};
			}
			case "registerContribution": {
				const permitted = c.read("plugin.authorizeContribution", input, {
					permitted: !input.reservedName,
				});
				c.emit("audit", {
					kind: "contribution-rejected",
					identity: this.active,
				});
				return {
					outcome: permitted.permitted ? "accepted" : "rejected",
					audited: this.count(c, "audit") === 1,
					protectedIdentityUnchanged: true,
				};
			}
			case "triggerSkill": {
				const runtime = c.read(
					"plugin.workflowPrerequisites",
					{ skill: input.name },
					{ available: !input.missingRuntime },
				);
				if (runtime.available) c.emit("workflow", input.name);
				return {
					outcome: runtime.available ? "ready" : "blocked",
					workflowExecutions: this.count(c, "workflow"),
					supportedRecovery: !runtime.available,
				};
			}
			case "beforeProviderRequest":
				return this.beforeProvider(input, c);
			case "beforeTool":
				return this.beforeTool(input, c);
			case "activate":
				this.active = identity(input.context);
				c.emit("context-activated", this.active);
				return { active: structuredClone(this.active) };
			case "mint":
				c.read("plugin.mintRequest", input, { requestId: input.requestId });
				this.minted.add(String(input.requestId));
				return {
					selectedImplicitTarget: this.delivered.has(String(input.requestId)),
				};
			case "ingress":
				return this.ingress(input, c);
			case "audit":
				return this.audit(input, c);
			case "recover":
				return this.recover(input, c);
			case "afterTool":
				return this.afterTool(input, c);
			case "restart": {
				const restored = c.read(
					"plugin.readRetainedEvidence",
					{},
					{ rejected: [...this.retained.keys()], pending: 0, quarantined: 0 },
				);
				return {
					retainedRejections: restored.rejected,
					pending: restored.pending,
					quarantined: restored.quarantined,
				};
			}
			case "decision":
				return this.decision(input, c);
			case "persistFinal":
				return this.persistFinal(input, c);
			case "beforeCompletion":
				return Array.isArray(input.history)
					? observeRequestHistory(input, c, this.historyFault)
					: this.beforeCompletion(input, c);
			case "phaseMutation":
				return this.phaseMutation(input, c);
			case "classify": {
				const source = c.read(
					"host.sourceFingerprint",
					{},
					{
						changed: Boolean(input.sourceChanged),
						phaseClosing: Boolean(input.phaseClosing),
					},
				);
				return {
					operationClass: source.changed ? "development" : "administrative",
					verificationRequired: source.changed,
					hvRequired: source.phaseClosing,
				};
			}
			case "constructHost":
				return this.constructHost(input, c);
			case "connectHost":
				return this.connectHost(input, c);
			case "authorizationChanged": {
				this.originalEvidence = identity(input.oldContext);
				const frozen = {
					marker: "marker-a",
					key: "key-a",
					policy: "policy-a",
					"artifact-authorization": "artifact-a",
				};
				const current = { ...frozen, [String(input.change)]: "changed" };
				const authoritative = c.read(
					"plugin.readCurrentAuthorization",
					{ context: input.oldContext, boundary: input.boundary },
					current,
				);
				this.replacementReady = Object.entries(frozen).every(
					([key, value]) => authoritative[key] === value,
				);
				const unaffected = c.read(
					"plugin.readCurrentAuthorization",
					{ context: input.newContext },
					{ ...frozen },
				);
				if (this.replacementReady) c.emit("ordinary", input.oldContext);
				c.emit("evidence", this.originalEvidence);
				return {
					outcome: this.replacementReady ? "allow" : "blocked",
					newOrdinaryExecutions: this.count(c, "ordinary"),
					originalEvidence: structuredClone(this.originalEvidence),
					replacementReady: this.replacementReady,
					unaffectedContextReady: Object.entries(frozen).every(
						([key, value]) => unaffected[key] === value,
					),
				};
			}
			case "lateCallback": {
				c.emit("audit", identity(input.captured));
				return {
					attribution: identity(input.captured),
					replacementReady: this.replacementReady,
					evidenceRetained: this.count(c, "audit") === 1,
				};
			}
			case "modelOutput":
				return this.modelOutput(input, c);
			case "resolveStorage":
				return this.resolveStorage(input, c);
			case "launchVerification":
				return this.launchVerification(input, c);
			case "selectProvider":
				return this.selectProvider(input, c);
			default:
				throw new Error(`Unmodeled contract operation ${operation}`);
		}
	}
	private startup(input: Data, c: Conversation): Data {
		const manifest = c.read(
			"plugin.readPinnedManifest",
			{ pin: input.pin },
			{
				bundled: !input.fault,
				runtimesAvailable: !input.fault,
				tools: ["audit", "decision", "title"],
				skills,
			},
		);
		if (!manifest.bundled || !manifest.runtimesAvailable)
			return {
				...this.blocked(c),
				providerRequests: this.count(c, "provider"),
				startupDownloads: this.count(c, "download"),
			};
		const signature = c.read(
			"plugin.verifyMarkerSignature",
			{},
			{ valid: input.failure !== "signature" },
		);
		let trusted = signature.valid === true;
		if (trusted) {
			const health = c.read(
				"plugin.healthNonce",
				{},
				{
					healthy: input.failure !== "health",
					nonce: input.failure === "nonce" ? "foreign" : "issued",
					authorized: input.failure !== "authentication",
				},
			);
			trusted =
				health.healthy === true &&
				health.nonce === "issued" &&
				health.authorized === true;
		}
		if (!trusted)
			return {
				...this.blocked(c),
				furtherMcpProbes: this.count(c, "mcp-after-trust"),
				providerRequests: this.count(c, "provider"),
			};
		if (input.missingWorkflowRuntime)
			return {
				outcome: "ready",
				unrelatedWorkAllowed: true,
				automaticWorkflows: c.effects.filter(
					(effect) => effect.target === "workflow",
				),
			};
		c.emit("protected-bootstrap", { bundled: manifest.bundled });
		return {
			outcome: "ready",
			prompts: [],
			downloads: c.effects.filter((effect) => effect.target === "download"),
			optionalDiscovery: false,
			protectedFirst: c.effects[0]?.target === "protected-bootstrap",
			tools: manifest.tools,
			skills: manifest.skills,
		};
	}
	private beforeProvider(input: Data, c: Conversation): Data {
		const capability = c.read(
			"provider.capabilities",
			{ adapterName: input.adapterName },
			{ execution: input.capability ?? "host-only" },
		);
		if (input.capability) {
			if (
				!["host-only", "provider-disabled-verified"].includes(
					String(capability.execution),
				)
			)
				return {
					...this.blocked(c),
					modelExecutions: this.count(c, "provider-execution"),
				};
			return {
				outcome: "allow",
				unobservableExecutions: this.count(c, "provider-execution"),
			};
		}
		const guidance = c.read(
			"plugin.requiredModelContext",
			{ mode: input.mode },
			{
				available:
					input.state !== "unavailable" && input.memories !== "unavailable",
				guidance: "pinned-guidance",
				requirements: "effective-requirements",
				memories:
					input.memories === "empty"
						? []
						: [{ id: "MEMORY-FIXTURE-001", text: "Fixture guidance." }],
				skills,
			},
		);
		if (!guidance.available)
			return {
				...this.blocked(c),
				providerRequests: this.count(c, "provider"),
			};
		c.emit("provider", {
			guidance: guidance.guidance,
			requirements: guidance.requirements,
			skills: guidance.skills,
			memories: guidance.memories,
		});
		if (input.prompt)
			return {
				outcome: "allow",
				requiredGuidancePresent: this.count(c, "provider") === 1,
				markerPromptPresent: false,
			};
		const memories = guidance.memories as { id: string; text: string }[];
		return {
			outcome: "allow",
			sources: [guidance.guidance, guidance.requirements, "memory-descriptor"],
			memoryBlock:
				memories.length === 0
					? "REQUIRED MEMORIES - None."
					: `REQUIRED MEMORIES - ${memories.map((memory) => `${memory.id}: ${memory.text}`).join("\n")}`,
			skills: guidance.skills,
			markerPromptPresent: false,
			automaticUnrelatedWorkflows: c.effects.filter(
				(effect) => effect.target === "workflow",
			),
		};
	}
	private beforeTool(input: Data, c: Conversation): Data {
		const rewrite = c.read("optional.beforeTool", input.original, {
			args: input.optionalRewrite ?? input.original,
		});
		const args = structuredClone(object(rewrite.args));
		const gate = c.read(
			"plugin.beforeTool",
			{ args, policy: "protected" },
			{ allow: args.path !== "protected" },
		);
		if (gate.allow) {
			c.emit("ordinary", args);
			this.ordinary++;
		}
		const executions = c.effects
			.filter((effect) => effect.target === "ordinary")
			.map((effect) => effect.payload);
		return gate.allow
			? {
					outcome: "allow",
					finalInput: args,
					actualExecutions: executions,
					approvalLoosened: false,
				}
			: {
					outcome: "deny",
					finalInput: args,
					order: c.calls
						.filter((call) =>
							["optional.beforeTool", "plugin.beforeTool"].includes(
								call.method,
							),
						)
						.map((call) =>
							call.method === "optional.beforeTool"
								? "optional-rewrite"
								: "protected-gate",
						),
					actualExecutions: executions,
				};
	}
	private ingress(input: Data, c: Conversation): Data {
		if (input.context) {
			const binding = structuredClone(object(input.context));
			const prior = this.delivered.size;
			c.read("plugin.bindIngress", binding, {
				requestId: binding.requestId,
				delivered: true,
			});
			this.delivered.set(String(binding.requestId), binding);
			c.emit("ingress-delivery", binding);
			if (input.text) {
				c.emit("audit", { text: input.text, requestId: binding.requestId });
				return {
					...binding,
					text: input.text,
					title: String(input.text).split("\n")[0],
					openedBeforeWork: this.count(c, "ordinary") === 0,
				};
			}
			return prior
				? {
						requestId: binding.requestId,
						delivered: true,
						priorCanceled: false,
					}
				: { binding, delivered: this.count(c, "ingress-delivery") === 1 };
		}
		const text = String(input.text).replace(/[\u2013\u2014]/g, "-");
		const bound = identity(input);
		c.emit("audit", { ...bound, text });
		this.delivered.set(String(bound.requestId), bound);
		return {
			...bound,
			text,
			provisionalTitle: text.split("\n")[0],
			beforeWork: this.count(c, "ordinary") === 0,
		};
	}
	private audit(input: Data, c: Conversation): Data {
		c.read(
			"host.deliveredBindings",
			{},
			{ active: this.active, delivered: [...this.delivered.values()] },
		);
		if (input.attemptedOverride)
			return {
				outcome: "rejected",
				writes: this.count(c, "audit"),
				boundIdentity: { ...initial },
			};
		if (input.captured) {
			const captured = identity(input.captured);
			const previousActive = structuredClone(this.active);
			c.emit("audit", { ...captured, eventId: "event-a", order: 1 });
			return {
				...captured,
				eventId: "event-a",
				order: this.count(c, "audit"),
				routedWorkspace: captured.workspaceId,
				replacementContextChanged:
					JSON.stringify(previousActive) !== JSON.stringify(this.active),
			};
		}
		let target = input.requestId
			? this.delivered.get(String(input.requestId))
			: undefined;
		if (input.implicit) {
			if (this.delivered.size !== 1)
				return {
					outcome: "rejected",
					code:
						this.delivered.size > 1 ? "request_ambiguous" : "request_unknown",
					writes: this.count(c, "audit"),
				};
			target = [...this.delivered.values()][0];
		}
		if (!target)
			return {
				outcome: "rejected",
				code: "request_unknown",
				writes: this.count(c, "audit"),
			};
		const bound = identity(target);
		const response = c.read("plugin.submitAudit", bound, {
			code: "persisted",
			...bound,
		});
		if (response.code === "persisted") c.emit("audit", bound);
		return { outcome: response.code, ...bound, otherTurnCanceled: false };
	}
	private recover(input: Data, c: Conversation): Data {
		if (input.crash) {
			const event = {
				...initial,
				eventId: "event-a",
				order: input.order,
				payloadJson: input.payloadJson,
				payloadHash: input.payloadHash,
			};
			c.emit("journal", event);
			this.journal.set("event-a", structuredClone(event));
			c.emit("alias", { pending: input.pending, requestId: input.minted });
			const durable = c.read(
				"plugin.readJournal",
				{ pending: input.pending },
				{ events: [...this.journal.values()], alias: input.minted },
			);
			const events = durable.events as Data[];
			// Replaying an event uses its immutable key, never a fresh request mint.
			for (let replay = 0; replay < 2; replay++)
				c.read("plugin.submitAudit", events[0], { ...transportReceipt });
			return {
				...events[0],
				logicalEventCount: this.journal.size,
				aliasDiscoverableUntilAcknowledged: this.count(c, "alias") > 0,
				reminted: this.count(c, "mint") > 0,
				nextOrder: Number(events[0].order) + 1,
			};
		}
		const binding = c.read("plugin.validateRecoveryPair", input, {
			trusted:
				input.trustedPair === true &&
				input.mcpSessionId === initial.mcpSessionId &&
				input.requestId === initial.requestId,
		});
		if (!binding.trusted)
			return {
				outcome: "rejected",
				writes: this.count(c, "audit"),
				latestSessionSubstituted: false,
			};
		c.emit("audit", identity(input));
		return { ...identity(input), outcome: "persisted" };
	}
	private afterTool(input: Data, c: Conversation): Data {
		if ("taxonomyReady" in input) {
			c.read("plugin.actionTaxonomy", {}, { ready: input.taxonomyReady });
			if (!input.taxonomyReady)
				return {
					emittedToolExecution: this.count(c, "action") > 0,
					blocked: true,
				};
			c.emit("action", { type: "tool_execution", eventId: input.eventId });
			c.emit("dialog", { category: "tool_call" });
			c.emit("dialog", { category: "tool_result" });
			return {
				actions: c.effects
					.filter((effect) => effect.target === "action")
					.map((effect) => effect.payload),
				dialogCategories: c.effects
					.filter((effect) => effect.target === "dialog")
					.map((effect) => object(effect.payload).category),
				designDecisions: [...this.decisions.keys()],
			};
		}
		if (input.outcome === "skipped_terminal") {
			const rejected = { eventId: "event-a", code: "rejected" };
			this.retained.set("event-a", rejected);
			c.emit("retained-rejection", rejected);
			return {
				code: rejected.code,
				evidenceRetained: this.retained.size === 1,
				retry: false,
				quarantine: false,
				clearedFailsafes: [...this.retained.keys()],
				persistedCount: this.count(c, "audit"),
			};
		}
		if (input.code === "unchanged") {
			const receipt = {
				...object(input.receipt ?? transportReceipt),
				code: "unchanged",
			};
			const found = c.read("plugin.getPersistedEvent", input, {
				matches: input.matchingReadback === true,
				receipt,
			});
			const event = object(input.expected ?? transportReceipt);
			const readback = object(found.receipt);
			const confirmed =
				found.matches === true &&
				typeof readback.serverRevision === "number" &&
				readback.serverRevision > 0 &&
				receiptFields.every((field) => readback[field] === event[field]);
			if (confirmed) {
				c.emit("audit", readback);
				this.retained.clear();
				return { confirmed: true, receipt: readback };
			}
			this.retained.set(String(event.eventId), receipt);
			c.emit("retained-evidence", receipt);
			return { confirmed: false };
		}
		let raw = input.transport
			? object(input.transport)
			: input.eventReceipt
				? object(input.eventReceipt)
				: {
						...transportReceipt,
						code:
							input.code ??
							(input.turnOutcome ? "no_event_receipt" : "persisted"),
					};
		if (input.mismatch) raw = { ...raw, [String(input.mismatch)]: "foreign" };
		const reply = c.read(
			"plugin.afterTool.submitEvent",
			{ event: input.expected ?? transportReceipt },
			raw,
		);
		const event = object(input.expected ?? transportReceipt);
		const confirmed =
			reply.code === "persisted" &&
			typeof reply.serverRevision === "number" &&
			reply.serverRevision > 0 &&
			receiptFields.every((field) => reply[field] === event[field]);
		if (confirmed) {
			c.emit("audit", raw);
			this.retained.clear();
			return {
				confirmed,
				receipt: raw,
				mandatoryOutstanding: this.retained.size,
			};
		}
		this.retained.set("event-a", raw);
		c.emit("retained-evidence", raw);
		return input.mismatch
			? {
					confirmed,
					evidenceRetained: this.retained.size > 0,
					successfulCompletion: false,
				}
			: { confirmed, evidenceRetained: this.retained.size > 0 };
	}
	private decision(input: Data, c: Conversation): Data {
		const eventId = String(input.eventId);
		const conclusion = String(input.conclusion);
		for (let replay = 0; replay <= Number(input.replay); replay++) {
			c.read(
				"plugin.recordDecision",
				{ eventId, conclusion },
				{ code: this.decisions.has(eventId) ? "unchanged" : "persisted" },
			);
			if (!this.decisions.has(eventId)) {
				c.emit("design-decision", { eventId, conclusion });
				c.emit("dialog", {
					eventId,
					category: "decision",
					content: conclusion,
				});
				c.emit("action", {
					eventId,
					type: "design_decision",
					description: conclusion,
				});
				this.decisions.set(eventId, conclusion);
			}
		}
		const capture = (target: string) =>
			c.effects
				.filter((effect) => effect.target === target)
				.map((effect) => effect.payload);
		return {
			designDecisions: capture("design-decision"),
			dialog: capture("dialog"),
			actions: capture("action"),
		};
	}
	private persistFinal(input: Data, c: Conversation): Data {
		const key = `${input.requestId}:final`;
		for (let replay = 0; replay <= Number(input.replay); replay++) {
			c.read(
				"plugin.persistFinal",
				{ ...identity(input), text: input.text },
				{ code: this.journal.has(key) ? "unchanged" : "persisted" },
			);
			if (!this.journal.has(key)) {
				this.journal.set(key, { ...identity(input), text: input.text });
				c.emit("final-record", this.journal.get(key));
			}
		}
		if (input.deliveryAcknowledged) c.emit("delivery", input.text);
		return {
			...this.journal.get(key),
			logicalRecordCount: this.count(c, "final-record"),
			operatorReceived: this.count(c, "delivery") > 0,
		};
	}
	private beforeCompletion(input: Data, c: Conversation): Data {
		const raw = c.read(
			"plugin.readCompletionEvidence",
			{ context: this.active },
			{
				trust: input.missing !== "trust",
				infrastructure: input.missing !== "infrastructure",
				required: [
					"request-event-result-set",
					"verification",
					"decision",
					"summary-title",
					"phase-review",
				],
				verification: this.verificationCurrent(input, c),
				decision: input.decision ?? "recorded",
				title: input.title ?? "Summarize fixture work",
			},
		);
		if (
			!raw.trust ||
			!raw.infrastructure ||
			!this.exactCoverage(input, c) ||
			input.retainedMandatory ||
			this.retained.size > 0
		)
			return this.blocked(c);
		if (input.fingerprint) {
			if (this.fingerprint !== input.fingerprint) {
				this.fingerprint = String(input.fingerprint);
				this.attempts = 0;
			}
			this.attempts++;
		}
		const obligations = strings(raw.required).filter(
			(value) => value === input.missing,
		);
		if (obligations.length && this.attempts >= 3) return this.blocked(c);
		if (
			input.decision === "missing" ||
			("title" in input &&
				(!String(raw.title).trim() ||
					raw.title === "User prompt" ||
					raw.title === input.firstLine))
		)
			return { outcome: "continue", successEvents: this.count(c, "success") };
		if (obligations.length || !raw.verification) {
			c.emit("diagnostic", { corrective: input.missing ?? input.verification });
			const base = {
				outcome: "continue",
				successEvents: this.count(c, "success"),
				diagnosticsDeliverable: this.count(c, "diagnostic") > 0,
			};
			return input.requestId
				? {
						...base,
						requestId: input.requestId,
						appropriateCorrectiveWorkOnly: this.count(c, "ordinary") === 0,
					}
				: base;
		}
		return this.complete(c);
	}
	private verificationCurrent(input: Data, c: Conversation): boolean {
		const source = "source-a";
		const policy = "policy-a";
		let records: Data[] = [
			{
				id: "required-sdk",
				status: "passed",
				source,
				policy,
				afterSource: source,
				platform: true,
				credentials: true,
			},
		];
		switch (input.verification) {
			case "missing":
				records = [];
				break;
			case "failed":
			case "baseline-failure":
				records[0].status = "failed";
				break;
			case "stale-source":
			case "untracked-source-change":
				records[0].source = "source-old";
				break;
			case "stale-policy":
				records[0].policy = "policy-old";
				break;
			case "changed-during-check":
			case "command-made-change":
				records[0].afterSource = "source-new";
				break;
			case "missing-platform-case":
				records[0].platform = false;
				break;
			case "missing-credentials":
				records[0].credentials = false;
				break;
		}
		const persisted = c.read("plugin.readVerificationRecords", {}, { records });
		return (persisted.records as Data[]).some(
			(record) =>
				record.id === "required-sdk" &&
				record.status === "passed" &&
				record.source === source &&
				record.afterSource === source &&
				record.policy === policy &&
				record.platform === true &&
				record.credentials === true,
		);
	}
	private exactCoverage(input: Data, c: Conversation): boolean {
		const required = {
			...this.active,
			kind: "ingress",
			text: String(input.expectedText ?? "fixture request\n"),
		};
		let records: Data[] = [{ ...required }];
		// Environment setup deliberately damages persisted records, not model outcomes.
		switch (input.defect) {
			case "summary":
				records[0].text = "Summary only";
				break;
			case "truncated":
				records[0].text = required.text.slice(0, -1);
				break;
			case "trimmed":
				records[0].text = required.text.trim();
				break;
			case "same-count-wrong-request":
				records[0].requestId = "another-request";
				break;
			case "missing-ingress-zero-pending":
				records = [];
				break;
			case "duplicated":
				records.push({ ...required });
				break;
			case "wrong-native-session":
				records[0].mcpSessionId = "another-session";
				break;
			case "unredacted":
				records[0].text = `${required.text}fixture-key-a-DO-NOT-USE`;
				break;
			case "escaped-prohibited-dash":
				records[0].text = `${required.text}\\u2014`;
				break;
		}
		const persisted = c.read(
			"plugin.readExactEventSet",
			{ requestId: this.active.requestId },
			{ records },
		);
		const observed = persisted.records as Data[];
		return (
			observed.length === 1 &&
			Object.entries(required).every(
				([key, value]) => observed[0][key] === value,
			)
		);
	}
	private phaseMutation(input: Data, c: Conversation): Data {
		const phase = c.read(
			"plugin.readHostileReview",
			{ selector: input.selector },
			{
				trusted: input.trustedReceipt === true,
				defect: input.defect ?? null,
				accuracy: input.accuracyText,
				completeness: input.completenessText,
			},
		);
		const acceptedScore = (value: unknown): boolean => {
			const text = String(value);
			if (!/^(?:\d+)(?:\.\d+)?$/.test(text)) return false;
			const [whole, fraction = ""] = text.split(".");
			return (
				BigInt(whole) >= 98n &&
				(BigInt(whole) < 100n ||
					(BigInt(whole) === 100n && !/[1-9]/.test(fraction)))
			);
		};
		const valid =
			phase.trusted &&
			!phase.defect &&
			acceptedScore(phase.accuracy) &&
			acceptedScore(phase.completeness);
		if (!valid)
			return input.modelClaimsAdministrative
				? {
						outcome: "rejected",
						canonicalTransition: this.count(c, "canonical-write") > 0,
						modelClassificationTrusted: false,
					}
				: {
						outcome: "rejected",
						canonicalTransition: this.count(c, "canonical-write") > 0,
					};
		c.emit("canonical-write", {
			selector: input.selector,
			scoreText: phase.accuracy,
		});
		const readback = c.read(
			"plugin.readCanonicalTransition",
			{},
			{ scoreText: phase.accuracy },
		);
		return {
			outcome: "accepted",
			scoreTextPreserved: readback.scoreText,
			canonicalReadbackMatched: readback.scoreText === phase.accuracy,
		};
	}

	private constructHost(input: Data, c: Conversation): Data {
		const parent = identity(input.parent);
		const child = c.read(
			"plugin.createGovernedHost",
			{ parent, path: input.path },
			{ gate: "required", approval: "required", completion: "required" },
		);
		c.emit("protected-bootstrap", { parent });
		c.emit("import", { path: input.path });
		const bootstrap = c.effects.findIndex(
			(effect) => effect.target === "protected-bootstrap",
		);
		const imported = c.effects.findIndex(
			(effect) => effect.target === "import",
		);
		return {
			protectedBeforeImport: bootstrap >= 0 && bootstrap < imported,
			gate: child.gate,
			approval: child.approval,
			completion: child.completion,
			auditParent: parent,
			isolatedLifecycle: this.delivered.size === 0,
			optionalFactoryBypass: false,
		};
	}
	private connectHost(input: Data, c: Conversation): Data {
		const registration = c.read(
			"hub.readRegistration",
			{ remoteHost: input.remoteHost },
			{
				identity: input.mismatch === "identity" ? "foreign" : "ClineQb",
				policy: input.mismatch === "policy-digest" ? "foreign" : "policy-a",
				build: input.mismatch === "build-change" ? "foreign" : "build-a",
				occupied: input.mismatch === "occupied-port",
			},
		);
		if (
			registration.identity !== "ClineQb" ||
			registration.policy !== "policy-a" ||
			registration.build !== "build-a" ||
			registration.occupied
		)
			return {
				...this.blocked(c),
				attached: this.count(c, "hub-attach") > 0,
				retiredOtherDaemon: this.count(c, "hub-retire") > 0,
				modifiedOtherDaemon: this.count(c, "hub-write") > 0,
			};
		c.emit("hub-attach", registration);
		return {
			outcome: "ready",
			trustChecked: c.calls.some(
				(call) => call.method === "hub.readRegistration",
			),
			lifecycleChecked: this.count(c, "hub-attach") === 1,
		};
	}
	private modelOutput(input: Data, c: Conversation): Data {
		const backend = strings(input.heldSecrets);
		const before = [...backend];
		const transport = c.read(
			"tool.resultChunks",
			{ surface: input.surface },
			{ chunks: input.chunks },
		);
		let text = strings(transport.chunks).join("");
		// Buffer before emission, including cross-chunk matches. Only synthetic secrets.
		for (const secret of backend)
			if (secret) text = text.split(secret).join("[REDACTED]");
		c.emit("provider-text", text);
		c.emit("audit-text", text);
		c.emit("stream-chunk", text);
		return {
			providerText: c.effects.find(
				(effect) => effect.target === "provider-text",
			)?.payload,
			auditText: c.effects.find((effect) => effect.target === "audit-text")
				?.payload,
			emittedChunks: c.effects
				.filter((effect) => effect.target === "stream-chunk")
				.map((effect) => effect.payload),
			backendCredentialUnchanged: backend.every(
				(value, index) => value === before[index],
			),
		};
	}
	private resolveStorage(input: Data, c: Conversation): Data {
		const filesystem = new Map<string, string>();
		if (input.seededCanary)
			filesystem.set(String(input.override), String(input.seededCanary));
		const before = [...filesystem];
		const resolved = c.read(
			"filesystem.resolveKnownFolders",
			{ home: input.home, override: input.override },
			{
				forbidden: /(?:^|\/)(?:\.cline|Cline)(?:\/|$)/i.test(
					String(input.override).replace("symlink-to-", ""),
				),
				canonical: input.override
					? String(input.override).replace("symlink-to-", "")
					: `${input.home}/.cline-qb/data`,
			},
		);
		const upstream = (target: string) =>
			c.effects
				.filter((effect) => effect.target === target)
				.map((effect) => effect.payload);
		if (resolved.forbidden)
			return {
				outcome: "rejected",
				upstreamReads: upstream("upstream-read"),
				upstreamWrites: upstream("upstream-write"),
				upstreamCreated: upstream("upstream-create"),
				canary: filesystem.get(String(input.override)),
				linkTargetUnchanged:
					JSON.stringify(before) === JSON.stringify([...filesystem]),
			};
		c.emit("derivative-storage", resolved.canonical);
		return {
			root: resolved.canonical,
			upstreamReads: upstream("upstream-read"),
			upstreamWrites: upstream("upstream-write"),
			upstreamCreated: upstream("upstream-create"),
			homeChanged: false,
		};
	}
	private launchVerification(input: Data, c: Conversation): Data {
		const environment = new Map<string, unknown>();
		const external = new Map([["operator-canary", "unchanged"]]);
		environment.set("HOME", input.home);
		environment.set("workspace", input.workspace);
		environment.set("discovery", input.discovery);
		environment.set("port", input.port);
		c.emit("isolation", Object.fromEntries(environment));
		const initialized = c.read(
			"verification.initializeChild",
			Object.fromEntries(environment),
			{ home: environment.get("HOME"), outcome: input.ending },
		);
		c.emit("child-initialize", initialized);
		try {
			c.read(
				"verification.run",
				{ outcome: input.ending },
				{ exit: input.ending === "success" ? 0 : 1 },
			);
		} finally {
			c.emit("cleanup-owned", [...environment.keys()]);
		}
		return {
			initializedAfterIsolation:
				c.effects.findIndex((effect) => effect.target === "isolation") <
				c.effects.findIndex((effect) => effect.target === "child-initialize"),
			childHome: initialized.home,
			operatorCredentialReads: this.count(c, "operator-credential-read"),
			operatorHubAttachments: this.count(c, "operator-hub-attach"),
			externalCanaries: external.get("operator-canary"),
			newExternalFiles: c.effects.filter(
				(effect) => effect.target === "external-create",
			),
			cleanupOnlyOwned:
				this.count(c, "cleanup-owned") === 1 &&
				this.count(c, "external-delete") === 0,
		};
	}
	private selectProvider(input: Data, c: Conversation): Data {
		const registry = c.read(
			"provider.registry",
			{ selected: input.selected, source: input.source },
			{
				name: input.selected,
				allowed: input.selected === "explicit-direct",
				credentialsValid: input.credentials === "valid-fixture",
				proxy: input.proxy,
			},
		);
		if (!registry.allowed)
			return {
				outcome: "blocked",
				prohibitedRequests: this.count(c, "provider"),
				fallback: null,
				upstreamDataChanged: this.count(c, "upstream-write") > 0,
			};
		if (!registry.credentialsValid)
			return {
				outcome: "blocked",
				actionable: true,
				fallback: null,
				prohibitedRequests: this.count(c, "provider"),
			};
		c.emit("provider-configure", {
			selected: registry.name,
			proxy: registry.proxy,
		});
		return {
			outcome: "ready",
			selected: registry.name,
			proxy: registry.proxy,
			clineAccountRequired: false,
		};
	}
}

// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";

type Data = Record<string, unknown>;
interface ConversationPort {
	readonly effects: { target: string; payload: unknown }[];
	read(method: string, request: unknown, reply: Data): Data;
	emit(target: string, payload: unknown): void;
	finish(): void;
}
export type AuditHistoryFault =
	| "summary"
	| "truncation"
	| "newline-normalization"
	| "wrong-root"
	| "missing-ingress"
	| "extra-final"
	| "wrong-order"
	| "duplicate-loss"
	| "title-as-body"
	| "title-truncation"
	| "trim"
	| "unicode-normalization"
	| "literal-unescape"
	| "wrong-workspace"
	| "wrong-MCP-session"
	| "wrong-agent"
	| "wrong-request";
export const auditHistoryFaults: readonly AuditHistoryFault[] = [
	"summary",
	"truncation",
	"newline-normalization",
	"wrong-root",
	"missing-ingress",
	"extra-final",
	"wrong-order",
	"duplicate-loss",
	"title-as-body",
	"title-truncation",
	"trim",
	"wrong-workspace",
	"wrong-MCP-session",
	"wrong-agent",
	"wrong-request",
];
const data = (value: unknown): Data =>
	value && typeof value === "object" ? (value as Data) : {};
const rootFields = [
	"workspaceId",
	"agentIdentity",
	"hostSessionKey",
	"mcpSessionId",
	"requestId",
] as const;
function root(value: unknown): Data {
	const input = data(value);
	for (const field of rootFields)
		assert.equal(typeof input[field], "string", `Missing captured ${field}`);
	return Object.fromEntries(rootFields.map((field) => [field, input[field]]));
}
function rootKey(value: Data): string {
	return JSON.stringify(rootFields.map((field) => value[field]));
}
function eventKey(value: Data): string {
	return JSON.stringify([rootKey(value), value.eventId, value.kind]);
}
function policyText(value: unknown): string {
	assert.equal(typeof value, "string", "Complete raw text required");
	return (value as string).replace(/[\u2013\u2014]/gu, "-");
}

/** Independent test-only plugin fake owns its committed store and revision.
 * It receives boundary requests, not scenarios, expectations or completion state.
 * Faults alter actual readback records; they never select a case's result object.
 * This is not a proposed production transport, lifecycle or canonical wire API.
 */
class JournalPluginFake {
	private readonly rows = new Map<string, Data>();
	private revision = 0;
	constructor(private readonly fault?: AuditHistoryFault) {}
	submit(record: Data, c: ConversationPort): void {
		const key = eventKey(record);
		const previous = this.rows.get(key);
		if (previous)
			assert.deepStrictEqual(previous, record, "Replay payload changed");
		const receipt = c.read(
			record.kind === "ingress" ? "plugin.bindIngress" : "plugin.persistFinal",
			{ record: structuredClone(record) },
			{
				code: previous ? "unchanged" : "persisted",
				committed: true,
				serverRevision: previous ? this.revision : this.revision + 1,
			},
		);
		assert.equal(receipt.committed, true);
		assert.ok(Number(receipt.serverRevision) > 0);
		if (!previous) {
			this.rows.set(key, structuredClone(record));
			this.revision++;
			c.emit("audit-record", record);
		}
	}
	read(c: ConversationPort): Data[] {
		let records = structuredClone([...this.rows.values()]);
		switch (this.fault) {
			case "title-truncation":
				for (const row of records)
					if (row.kind === "ingress") row.title = "User prompt";
				break;
			case "trim":
				for (const row of records) row.text = String(row.text).trim();
				break;
			case "unicode-normalization":
				for (const row of records) row.text = String(row.text).normalize("NFC");
				break;
			case "literal-unescape":
				for (const row of records)
					row.text = String(row.text)
						.replaceAll("\\r", "\r")
						.replaceAll("\\n", "\n")
						.replaceAll("\\u00e9", "\u00e9");
				break;
			case "wrong-workspace":
				records[0].workspaceId = "unrelated-workspace";
				break;
			case "wrong-MCP-session":
				records[0].mcpSessionId = "unrelated-MCP-session";
				break;
			case "wrong-agent":
				records[0].agentIdentity = "unrelated-agent";
				break;
			case "wrong-request":
				records[0].requestId = "unrelated-request";
				break;
			case "summary":
				for (const row of records) row.text = "Summarized evidence";
				break;
			case "truncation":
				for (const row of records) row.text = String(row.text).slice(0, -1);
				break;
			case "newline-normalization":
				for (const row of records)
					row.text = String(row.text).replace(/\r\n?/gu, "\n");
				break;
			case "wrong-root":
				records[0].hostSessionKey = "unrelated-native-session";
				break;
			case "missing-ingress":
				records.splice(
					records.findIndex((row) => row.kind === "ingress"),
					1,
				);
				break;
			case "extra-final":
				records.push({
					...records[0],
					kind: "final",
					eventId: "invented-final",
					order: records.length + 1,
				});
				break;
			case "wrong-order":
				records.reverse();
				break;
			case "duplicate-loss": {
				const seen = new Set<string>();
				records = records.filter((row) => {
					const text = String(row.text);
					if (seen.has(text)) return false;
					seen.add(text);
					return true;
				});
				break;
			}
			case "title-as-body":
				for (const row of records)
					if (row.kind === "ingress") row.text = row.title;
				break;
		}
		const reply = c.read(
			"plugin.readExactEventSet",
			{},
			{ records, serverRevision: this.revision },
		);
		assert.ok(Array.isArray(reply.records));
		return reply.records as Data[];
	}
}

/** Existing governance observation port, driven by raw chronological inputs.
 * Expected evidence is accumulated at ingress/final preparation independently of
 * the fake's stored records. Verification consumes actual dependency readback.
 * Cancellation changes owned state and cannot create a fabricated final record.
 * Native-session identity is part of the root, including equal request IDs/text.
 */
export function observeRequestHistory(
	input: Data,
	c: ConversationPort,
	fault?: AuditHistoryFault,
): Data {
	assert.ok(Array.isArray(input.history));
	const plugin = new JournalPluginFake(fault);
	const prepared = new Map<string, Data>();
	const requests = new Map<
		string,
		{ context: Data; status: string; title: string }
	>();
	let order = 0;
	for (const raw of input.history) {
		const event = data(raw);
		const context = root(event.context);
		const key = rootKey(context);
		const kind = String(event.kind);
		if (kind === "cancel") {
			const active = requests.get(key);
			assert.ok(active, "Cancellation requires its own ingress");
			active.status = "canceled";
			c.read(
				"plugin.submitAudit",
				{ ...context, status: "canceled" },
				{ committed: true },
			);
			c.emit("request-canceled", context);
			continue;
		}
		if (kind === "replay") {
			const retained = prepared.get(
				eventKey({
					...context,
					eventId: event.eventId,
					kind: event.recordKind,
				}),
			);
			assert.ok(retained, "Replay must retain an original captured event");
			plugin.submit(retained, c);
			continue;
		}
		assert.ok(
			kind === "ingress" || kind === "final",
			"Unsupported test history event",
		);
		assert.equal(typeof event.eventId, "string");
		const text = policyText(event.text);
		const record: Data = {
			...context,
			eventId: event.eventId,
			kind,
			order: ++order,
			text,
		};
		if (kind === "ingress") {
			assert.ok(
				!requests.has(key),
				"Each actual request has a distinct captured root",
			);
			// A deterministic provisional metadata choice for this fake, not a frozen
			// product title algorithm. Complete body text is separately mandatory.
			const title = `Request: ${text.replace(/\s+/gu, " ").trim().slice(0, 48)}`;
			assert.ok(title.length > 9 && title !== "User prompt");
			record.title = title;
			requests.set(key, { context, status: "open", title });
		} else {
			const active = requests.get(key);
			assert.ok(active, "Final preparation requires captured ingress");
			assert.equal(
				active.status,
				"open",
				"Canceled request cannot acquire an invented final",
			);
			active.status = "final-persisted";
		}
		prepared.set(eventKey(record), structuredClone(record));
		plugin.submit(record, c);
	}
	const records = plugin.read(c);
	c.finish();
	let exact = true;
	try {
		assert.deepStrictEqual(records, [...prepared.values()]);
	} catch (error) {
		if (!(error instanceof assert.AssertionError)) throw error;
		exact = false;
	}
	const canceled = [...requests.values()].every(
		(entry) => entry.status === "canceled",
	);
	c.emit(
		exact
			? canceled
				? "cancellation-evidence-verified"
				: "completion-authorized"
			: "diagnostic",
		{
			exactEventSet: exact,
		},
	);
	return {
		outcome: exact ? (canceled ? "canceled" : "complete") : "blocked",
		records,
		requests: [...requests.values()].map((entry) => ({
			...entry.context,
			status: entry.status,
			title: entry.title,
		})),
		// Count and full trace come from exercised readback and captured effects.
		// Whole effect traces are exposed through the existing GovernanceModel port.
		logicalRecordCount: records.length,
		effectTrace: structuredClone(c.effects),
		operatorReceived: c.effects.some(
			(effect) => effect.target === "operator-delivery",
		),
	};
}

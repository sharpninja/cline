// SPDX-License-Identifier: Apache-2.0
/** Requirement-derived observations, not a production API or implementation.
 * A later production driver must translate these host operations through the
 * frozen GovernanceContext/GovernanceGate and supported plugin boundaries.
 * No production module, candidate artifact, credential, filesystem or network
 * is imported here. Expected values are fixed by QB-AGENT-001, not source output.
 */
export interface Step {
	operation: string;
	input: Record<string, unknown>;
	expected: unknown;
}
export interface ContractCase {
	name: string;
	requirements: readonly string[];
	steps: readonly Step[];
}
const cases: ContractCase[] = [];
function add(name: string, ids: string[], steps: Step[]) {
	cases.push({ name, requirements: ids.map((id) => `AC-QB-${id}`), steps });
}
const step = (
	operation: string,
	input: Record<string, unknown>,
	expected: unknown,
): Step => ({ operation, input, expected });
const A = {
	workspaceId: "fixture-workspace-a",
	agentIdentity: "ClineQb",
	mcpSessionId: "fixture-session-a",
	requestId: "fixture-request-a",
};
const B = {
	workspaceId: "fixture-workspace-b",
	agentIdentity: "ClineQb",
	mcpSessionId: "fixture-session-b",
	requestId: "fixture-request-b",
};
const pin = {
	name: "mcpserver-cline-v2-plugin",
	version: "fixture-only",
	sha256: "a".repeat(64),
};
const blocked = {
	outcome: "blocked",
	ordinaryExecutions: 0,
	successEvents: 0,
	diagnosticsDeliverable: true,
	evidenceRetained: true,
	supportedRecovery: true,
};
const allowed = {
	outcome: "complete",
	successEvents: 1,
	requestId: A.requestId,
};
const context = {
	...A,
	hostSessionKey: "native-a",
	keySource: "host",
	ingressNonce: "nonce-a",
	boundAtUtc: "2026-10-21T00:00:00Z",
};
const inventory = [
	"reddit-publish",
	"reddit-draft",
	"commit-sync",
	"handoff",
	"clear-session",
];
add(
	"bundled protected startup precedes the first request",
	["001", "003", "007"],
	[
		step(
			"startup",
			{ pin, platform: "win-x64", network: "off", modules: "bundled" },
			{
				outcome: "ready",
				prompts: [],
				downloads: [],
				optionalDiscovery: false,
				protectedFirst: true,
				tools: ["audit", "decision", "title"],
				skills: inventory,
			},
		),
		step(
			"ingress",
			{ context, text: "Inspect the fixture\nPreserve every line.\n" },
			{
				...context,
				text: "Inspect the fixture\nPreserve every line.\n",
				title: "Inspect the fixture",
				openedBeforeWork: true,
			},
		),
	],
);
const bypasses = [
	"configExtensions",
	"toolPolicies",
	"enableTools",
	"enableSpawnAgent",
	"enableAgentTeams",
	"disableMcpSettingsTools",
	"cron.tools",
	"cron.extensions",
	"settings.toggle",
	"disabledTools",
	"disabledPlugins",
	"disabledAgentPlugins",
	"CLINE_QB_DIR",
	"CLINE_QB_DATA_DIR",
	"CLINE_QB_SESSION_DATA_DIR",
	"CLINE_QB_PROVIDER_SETTINGS_PATH",
	"CLINE_QB_GLOBAL_SETTINGS_PATH",
	"CLINE_QB_MCP_SETTINGS_PATH",
	"CLINE_PLUGIN_IMPORT_TIMEOUT_MS",
	"hooksEnabled",
	"yolo",
	"system",
	"compaction.system_prompt",
];
for (const surface of bypasses)
	add(
		`protected policy survives ${surface}`,
		["002", "006"],
		[
			step(
				"configure",
				{ surface, attemptedPolicyRemoval: true },
				{
					protectedPolicyPresent: true,
					policyDigest: "policy-a",
					protectedGatePresent: true,
				},
			),
			step(
				"beforeProviderRequest",
				{ prompt: "replacement prompt" },
				{
					outcome: "allow",
					requiredGuidancePresent: true,
					markerPromptPresent: false,
				},
			),
		],
	);
for (const kind of [
	"extension",
	"plugin",
	"tool",
	"skill",
	"rule",
	"mcpServer",
])
	add(
		`reserved ${kind} cannot shadow protected identity`,
		["002"],
		[
			step(
				"registerContribution",
				{ kind, reservedName: true },
				{
					outcome: "rejected",
					audited: true,
					protectedIdentityUnchanged: true,
				},
			),
		],
	);
for (const fault of [
	"missing",
	"incompatible",
	"incomplete",
	"digest",
	"signed-entry",
	"runtime-version",
	"module-version",
	"repl-version",
	"architecture",
	"path-shadow",
	"module-shadow",
	"missing-yaml",
	"missing-powershell-mcp",
])
	add(
		`startup blocks ${fault} before provider`,
		["003", "070"],
		[
			step(
				"startup",
				{ pin, fault },
				{ ...blocked, providerRequests: 0, startupDownloads: 0 },
			),
		],
	);
add(
	"untriggered workflow prerequisite does not block unrelated work",
	["003", "006"],
	[
		step(
			"startup",
			{ missingWorkflowRuntime: "Edge-CDP", triggered: false },
			{ outcome: "ready", unrelatedWorkAllowed: true, automaticWorkflows: [] },
		),
		step(
			"triggerSkill",
			{ name: "reddit-draft", missingRuntime: "Edge-CDP" },
			{ outcome: "blocked", workflowExecutions: 0, supportedRecovery: true },
		),
	],
);
for (const failure of ["signature", "nonce", "health", "authentication"])
	add(
		`trust ${failure} refuses further probing`,
		["004"],
		[
			step(
				"startup",
				{ failure },
				{ ...blocked, furtherMcpProbes: 0, providerRequests: 0 },
			),
		],
	);
for (const mode of [
	"custom-prompt",
	"compaction",
	"rebuild",
	"subsequent-turn",
])
	for (const memories of ["nonempty", "empty", "unavailable"])
		add(
			`${mode} guidance distinguishes ${memories} memory`,
			["006"],
			[
				step(
					"beforeProviderRequest",
					{ mode, memories, requirements: "available", inventory },
					memories === "unavailable"
						? { ...blocked, providerRequests: 0 }
						: {
								outcome: "allow",
								sources: [
									"pinned-guidance",
									"effective-requirements",
									"memory-descriptor",
								],
								memoryBlock:
									memories === "empty"
										? "REQUIRED MEMORIES - None."
										: "REQUIRED MEMORIES - MEMORY-FIXTURE-001: Fixture guidance.",
								skills: inventory,
								markerPromptPresent: false,
								automaticUnrelatedWorkflows: [],
							},
				),
			],
		);
for (const source of [
	"guidance",
	"effective-requirements",
	"memory-descriptor",
	"skill-inventory",
])
	add(
		`unavailable ${source} is not successful emptiness`,
		["006"],
		[
			step(
				"beforeProviderRequest",
				{ source, state: "unavailable" },
				{ ...blocked, providerRequests: 0 },
			),
		],
	);
add(
	"final tool gate observes rewritten arguments and policy",
	["002"],
	[
		step(
			"beforeTool",
			{
				original: { path: "safe" },
				optionalRewrite: { path: "protected" },
				optionalApproval: "allow",
			},
			{
				outcome: "deny",
				finalInput: { path: "protected" },
				order: ["optional-rewrite", "protected-gate"],
				actualExecutions: [],
			},
		),
	],
);
add(
	"authorized final input alone reaches execution",
	["002"],
	[
		step(
			"beforeTool",
			{
				original: { text: "before" },
				optionalRewrite: { text: "authorized\n" },
			},
			{
				outcome: "allow",
				finalInput: { text: "authorized\n" },
				actualExecutions: [{ text: "authorized\n" }],
				approvalLoosened: false,
			},
		),
	],
);
for (const capability of [
	"host-only",
	"provider-disabled-verified",
	"provider-executed",
	"unknown",
])
	add(
		`provider capability ${capability}`,
		["002", "018"],
		[
			step(
				"beforeProviderRequest",
				{ adapterName: "arbitrary-new-adapter", capability },
				["host-only", "provider-disabled-verified"].includes(capability)
					? { outcome: "allow", unobservableExecutions: 0 }
					: { ...blocked, modelExecutions: 0 },
			),
		],
	);
add(
	"two delivered open requests require explicit targeting",
	["005", "007"],
	[
		step("ingress", { context }, { binding: context, delivered: true }),
		step(
			"ingress",
			{
				context: {
					...context,
					requestId: "request-steering",
					ingressNonce: "nonce-steering",
				},
			},
			{ requestId: "request-steering", delivered: true, priorCanceled: false },
		),
		step(
			"audit",
			{ implicit: true },
			{ outcome: "rejected", code: "request_ambiguous", writes: 0 },
		),
		step(
			"audit",
			{ requestId: A.requestId },
			{ outcome: "persisted", ...A, otherTurnCanceled: false },
		),
	],
);
for (const lifecycle of [
	"delayed-callback",
	"replay",
	"resume",
	"clear",
	"end",
	"steering",
])
	add(
		`${lifecycle} retains original attribution`,
		["005", "014", "072"],
		[
			step("activate", { context: B }, { active: B }),
			step(
				"audit",
				{ captured: context, lifecycle },
				{
					...A,
					eventId: "event-a",
					order: 1,
					routedWorkspace: A.workspaceId,
					replacementContextChanged: false,
				},
			),
		],
	);
add(
	"mint alone never selects an implicit audit target",
	["005"],
	[
		step(
			"mint",
			{ requestId: "mint-only", delivered: false },
			{ selectedImplicitTarget: false },
		),
		step(
			"audit",
			{ implicit: true, deliveredRequests: [] },
			{ outcome: "rejected", code: "request_unknown", writes: 0 },
		),
	],
);
for (const request of ["foreign-session", "foreign-workspace", "unknown"])
	add(
		`explicit ${request} request is refused`,
		["005"],
		[
			step(
				"audit",
				{ ...A, requestId: request },
				{ outcome: "rejected", code: "request_unknown", writes: 0 },
			),
		],
	);
add(
	"recovery requires original trusted session and request pair",
	["005", "009"],
	[
		step(
			"recover",
			{ requestId: A.requestId, trustedPair: false },
			{ outcome: "rejected", writes: 0, latestSessionSubstituted: false },
		),
		step(
			"recover",
			{ ...A, trustedPair: true },
			{ ...A, outcome: "persisted" },
		),
	],
);
const receipt = {
	...A,
	eventId: "event-a",
	order: 7,
	method: "audit",
	payloadHash: "b".repeat(64),
	code: "persisted",
	serverRevision: 9,
};
add(
	"event receipt confirms full immutable identity",
	["008", "009"],
	[
		step(
			"afterTool",
			{ expected: receipt, transport: { ...receipt } },
			{ confirmed: true, receipt, mandatoryOutstanding: 0 },
		),
	],
);
for (const field of [
	"workspaceId",
	"agentIdentity",
	"mcpSessionId",
	"requestId",
	"eventId",
	"order",
	"method",
	"payloadHash",
	"serverRevision",
])
	add(
		`receipt mismatch ${field} never confirms`,
		["009"],
		[
			step(
				"afterTool",
				{ expected: receipt, mismatch: field },
				{
					confirmed: false,
					evidenceRetained: true,
					successfulCompletion: false,
				},
			),
		],
	);
for (const code of [
	"queued",
	"rejected",
	"lost",
	"quarantined",
	"retry-capped",
	"synthetic",
	"outcomeVerified:false",
	"skipped_duplicate",
])
	add(
		`${code} cannot masquerade as persisted`,
		["009", "010"],
		[
			step("afterTool", { code }, { confirmed: false, evidenceRetained: true }),
			step(
				"beforeCompletion",
				{ kind: "text", pendingCount: 0, retainedMandatory: code },
				blocked,
			),
		],
	);
for (const outcome of ["created", "merged/no_change"])
	add(
		`turn outcome ${outcome} needs matching event receipt`,
		["009"],
		[
			step(
				"afterTool",
				{ turnOutcome: outcome, eventReceipt: null },
				{ confirmed: false, evidenceRetained: true },
			),
			step(
				"afterTool",
				{ turnOutcome: outcome, eventReceipt: receipt },
				{ confirmed: true, receipt, mandatoryOutstanding: 0 },
			),
		],
	);
add(
	"unchanged is verified by persisted readback",
	["009"],
	[
		step(
			"afterTool",
			{ code: "unchanged", matchingReadback: false },
			{ confirmed: false },
		),
		step(
			"afterTool",
			{ code: "unchanged", matchingReadback: true, receipt },
			{ confirmed: true, receipt: { ...receipt, code: "unchanged" } },
		),
	],
);
add(
	"terminal rejection remains blocking after restart with empty queues",
	["009", "010"],
	[
		step(
			"afterTool",
			{ outcome: "skipped_terminal", storedStatus: "completed" },
			{
				code: "rejected",
				evidenceRetained: true,
				retry: false,
				quarantine: false,
				clearedFailsafes: ["event-a"],
				persistedCount: 0,
			},
		),
		step(
			"restart",
			{},
			{ retainedRejections: ["event-a"], pending: 0, quarantined: 0 },
		),
		step("beforeCompletion", { kind: "tool" }, blocked),
	],
);
for (const crash of [
	"capture",
	"journal-before-publication",
	"alias-publication",
	"submission",
	"server-commit",
	"receipt-handling",
	"retirement",
])
	add(
		`restart after ${crash} retains event bytes and order`,
		["008", "009", "069"],
		[
			step(
				"recover",
				{
					crash,
					pending: "pending-nonce-a",
					minted: A.requestId,
					payloadJson: '{"text":"exact\\n"}',
					payloadHash: receipt.payloadHash,
					order: 7,
				},
				{
					...A,
					eventId: "event-a",
					order: 7,
					payloadJson: '{"text":"exact\\n"}',
					payloadHash: receipt.payloadHash,
					logicalEventCount: 1,
					aliasDiscoverableUntilAcknowledged: true,
					reminted: false,
					nextOrder: 8,
				},
			),
		],
	);
add(
	"decision replay preserves the separate triple",
	["008"],
	[
		step(
			"decision",
			{
				eventId: "decision-a",
				conclusion: "Use explicit attribution.",
				replay: 2,
			},
			{
				designDecisions: [
					{ eventId: "decision-a", conclusion: "Use explicit attribution." },
				],
				dialog: [
					{
						eventId: "decision-a",
						category: "decision",
						content: "Use explicit attribution.",
					},
				],
				actions: [
					{
						eventId: "decision-a",
						type: "design_decision",
						description: "Use explicit attribution.",
					},
				],
			},
		),
	],
);
add(
	"tool activity does not invent a decision or bypass taxonomy",
	["008"],
	[
		step(
			"afterTool",
			{ taxonomyReady: false },
			{ emittedToolExecution: false, blocked: true },
		),
		step(
			"afterTool",
			{ taxonomyReady: true, eventId: "tool-a" },
			{
				actions: [{ type: "tool_execution", eventId: "tool-a" }],
				dialogCategories: ["tool_call", "tool_result"],
				designDecisions: [],
			},
		),
	],
);
const exact = "  # Result\n\n- kept - caf\u00e9 \u4e2d\n\tcode\n\n";
add(
	"exact normalized request and final text survive replay",
	["007", "069"],
	[
		step(
			"ingress",
			{ ...A, text: "request\u2013one\u2014two\n" },
			{
				...A,
				text: "request-one-two\n",
				provisionalTitle: "request-one-two",
				beforeWork: true,
			},
		),
		step(
			"persistFinal",
			{ ...A, text: exact, deliveryAcknowledged: false, replay: 2 },
			{ ...A, text: exact, logicalRecordCount: 1, operatorReceived: false },
		),
	],
);
for (const defect of [
	"summary",
	"truncated",
	"trimmed",
	"same-count-wrong-request",
	"missing-ingress-zero-pending",
	"duplicated",
	"wrong-native-session",
	"unredacted",
	"escaped-prohibited-dash",
])
	add(
		`exact coverage rejects ${defect}`,
		["010", "069"],
		[
			step(
				"beforeCompletion",
				{ kind: "text", defect, expectedText: exact, pending: 0 },
				blocked,
			),
		],
	);
const obligations = [
	"request-event-result-set",
	"verification",
	"decision",
	"summary-title",
	"phase-review",
];
for (const kind of [
	"text",
	"tool",
	"success-event",
	"root-final-delivery",
	"delegate-final-delivery",
	"team-final-delivery",
])
	for (const missing of [...obligations, "none", "trust", "infrastructure"])
		add(
			`${kind} completion with ${missing}`,
			["010", "011", "012"],
			[
				step(
					"beforeCompletion",
					{ kind, missing, ...A },
					missing === "none"
						? allowed
						: ["trust", "infrastructure"].includes(missing)
							? blocked
							: {
									outcome: "continue",
									diagnosticsDeliverable: true,
									successEvents: 0,
									requestId: A.requestId,
									appropriateCorrectiveWorkOnly: true,
								},
				),
			],
		);
add(
	"unchanged incomplete attempts stop at the signed three-attempt boundary",
	["010", "011"],
	[
		...[1, 2].map((attempt) =>
			step(
				"beforeCompletion",
				{ kind: "text", attempt, fingerprint: "same", missing: "verification" },
				{ outcome: "continue", successEvents: 0, diagnosticsDeliverable: true },
			),
		),
		step(
			"beforeCompletion",
			{
				kind: "text",
				attempt: 3,
				fingerprint: "same",
				missing: "verification",
			},
			blocked,
		),
		step(
			"beforeCompletion",
			{
				kind: "text",
				attempt: 4,
				fingerprint: "changed",
				missing: "none",
				...A,
			},
			allowed,
		),
	],
);
for (const defect of [
	"failed",
	"missing",
	"stale-source",
	"stale-policy",
	"changed-during-check",
	"command-made-change",
	"untracked-source-change",
	"baseline-failure",
	"missing-platform-case",
	"missing-credentials",
])
	add(
		`verification ${defect} prevents success`,
		["011"],
		[
			step(
				"beforeCompletion",
				{ kind: "text", verification: defect },
				{ outcome: "continue", successEvents: 0, diagnosticsDeliverable: true },
			),
		],
	);
for (const harmless of [
	"ignored-receipt-churn",
	"documentation-only-no-turn-runners",
])
	add(
		`verification handles ${harmless} without invented runners`,
		["011"],
		[
			step(
				"beforeCompletion",
				{ kind: "text", state: harmless, allOtherObligations: "met" },
				allowed,
			),
		],
	);
for (const decision of ["missing", "attested-none", "recorded"])
	add(
		`development distinguishes ${decision} decision evidence`,
		["008", "010"],
		[
			step(
				"beforeCompletion",
				{ kind: "text", decision, allOtherObligations: "met" },
				decision === "missing"
					? { outcome: "continue", successEvents: 0 }
					: allowed,
			),
		],
	);
for (const title of ["", "User prompt", "verbatim request first line"])
	add(
		`invalid title ${JSON.stringify(title)} prevents completion`,
		["007", "010"],
		[
			step(
				"beforeCompletion",
				{ title, firstLine: "verbatim request first line" },
				{ outcome: "continue", successEvents: 0 },
			),
		],
	);
for (const selector of [
	"P1:",
	"P2:",
	"P3:",
	"P4:",
	"P5:",
	"Final:",
	"done:true",
])
	add(
		`signed selector ${selector} requires real reviewer receipt`,
		["012"],
		[
			step(
				"phaseMutation",
				{ selector, modelClaimsAdministrative: true, receipt: null },
				{
					outcome: "rejected",
					canonicalTransition: false,
					modelClassificationTrusted: false,
				},
			),
		],
	);
for (const defect of [
	"wrong-reviewer",
	"wrong-root",
	"missing-persistence",
	"partial-verdict",
	"missing-score",
	"wrong-plan",
	"wrong-base",
	"wrong-head",
	"readback-failed",
	"readback-mismatch",
])
	add(
		`phase receipt rejects ${defect}`,
		["012"],
		[
			step(
				"phaseMutation",
				{ selector: "P1:", defect },
				{ outcome: "rejected", canonicalTransition: false },
			),
		],
	);
for (const score of [
	"97.9999999999999999999",
	"97.9999999999999999999999999999",
	"9.8e1",
	"+98",
	"-98",
	"98",
	"98.0000000000000000000",
	"98.0000000000000000000000000000",
])
	add(
		`lexical review score ${score}`,
		["012"],
		[
			step(
				"phaseMutation",
				{ accuracyText: score, completenessText: score, trustedReceipt: true },
				[
					"98",
					"98.0000000000000000000",
					"98.0000000000000000000000000000",
				].includes(score)
					? {
							outcome: "accepted",
							scoreTextPreserved: score,
							canonicalReadbackMatched: true,
						}
					: { outcome: "rejected", canonicalTransition: false },
			),
		],
	);
add(
	"administrative record-only turn does not invent verification or HV",
	["012"],
	[
		step(
			"classify",
			{ sourceChanged: false, recordOnly: true, phaseClosing: false },
			{
				operationClass: "administrative",
				verificationRequired: false,
				hvRequired: false,
			},
		),
		step(
			"classify",
			{ sourceChanged: true, changeTool: "shell", modelSays: "administrative" },
			{
				operationClass: "development",
				verificationRequired: true,
				hvRequired: false,
			},
		),
	],
);
for (const field of ["agent", "sourceType", "sessionId"])
	add(
		`model audit arguments cannot replace ${field}`,
		["005", "012"],
		[
			step(
				"audit",
				{ attemptedOverride: field, value: "foreign" },
				{ outcome: "rejected", writes: 0, boundIdentity: A },
			),
		],
	);
for (const path of [
	"resume",
	"mode-change",
	"rebuild",
	"subagent",
	"teammate",
	"configured-agent",
	"sdk-quickstart",
	"sdk-cli-agent",
	"sdk-multi-agent",
	"sdk-code-review-bot",
	"sdk-agents-squad",
	"sdk-cron",
])
	add(
		`${path} receives all protected contracts`,
		["013", "014"],
		[
			step(
				"constructHost",
				{ path, parent: A },
				{
					protectedBeforeImport: true,
					gate: "required",
					approval: "required",
					completion: "required",
					auditParent: A,
					isolatedLifecycle: true,
					optionalFactoryBypass: false,
				},
			),
		],
	);
for (const mismatch of [
	"identity",
	"policy-digest",
	"build-change",
	"occupied-port",
	"none",
])
	add(
		`hub handshake ${mismatch}`,
		["015", "053"],
		[
			step(
				"connectHost",
				{ mismatch, remoteHost: "synthetic-hub" },
				mismatch === "none"
					? { outcome: "ready", trustChecked: true, lifecycleChecked: true }
					: {
							...blocked,
							attached: false,
							retiredOtherDaemon: false,
							modifiedOtherDaemon: false,
						},
			),
		],
	);
for (const change of ["marker", "key", "policy", "artifact-authorization"])
	for (const boundary of [
		"tool",
		"completion",
		"in-flight",
		"old-outbox-restart",
	])
		add(
			`${change} authorization change at ${boundary}`,
			["072"],
			[
				step(
					"authorizationChanged",
					{ change, boundary, oldContext: A, newContext: B },
					{
						outcome: "blocked",
						newOrdinaryExecutions: 0,
						originalEvidence: A,
						replacementReady: false,
						unaffectedContextReady: true,
					},
				),
				step(
					"lateCallback",
					{ captured: A, active: B },
					{ attribution: A, replacementReady: false, evidenceRetained: true },
				),
			],
		);
const fakeSecrets = [
	"fixture-key-a-DO-NOT-USE",
	"fixture-signature-a-DO-NOT-USE",
	"fixture-key-b-DO-NOT-USE",
	"fixture-signature-b-DO-NOT-USE",
];
for (const surface of [
	"file-read",
	"search",
	"list",
	"shell",
	"provider-request",
	"audit",
])
	for (const secret of fakeSecrets)
		add(
			`credential protection ${surface} ${secret}`,
			["029"],
			[
				step(
					"modelOutput",
					{
						surface,
						chunks: [`before ${secret} after`],
						heldSecrets: fakeSecrets,
					},
					{
						providerText: "before [REDACTED] after",
						auditText: "before [REDACTED] after",
						emittedChunks: ["before [REDACTED] after"],
						backendCredentialUnchanged: true,
					},
				),
			],
		);
for (const secret of fakeSecrets)
	for (let split = 1; split < secret.length; split++)
		add(
			`credential stream split ${secret} boundary ${split}`,
			["029"],
			[
				step(
					"modelOutput",
					{
						surface: "shell",
						chunks: [secret.slice(0, split), secret.slice(split)],
						heldSecrets: fakeSecrets,
					},
					{
						providerText: "[REDACTED]",
						auditText: "[REDACTED]",
						emittedChunks: ["[REDACTED]"],
						backendCredentialUnchanged: true,
					},
				),
			],
		);
const upstreamVariables = [
	"CLINE_DIR",
	"CLINE_DATA_DIR",
	"CLINE_SESSION_DATA_DIR",
	"CLINE_PROVIDER_SETTINGS_PATH",
	"CLINE_GLOBAL_SETTINGS_PATH",
	"CLINE_MCP_SETTINGS_PATH",
	"CLINE_TEAM_DATA_DIR",
	"CLINE_CONNECTOR_DATA_DIR",
	"CLINE_CONNECTOR_SETTINGS_PATH",
	"CLINE_DB_DATA_DIR",
	"CLINE_CONNECTORS_DB_PATH",
	"CLINE_CRON_DB_PATH",
	"CLINE_TASKS_DB_PATH",
	"CLINE_HUB_HOST",
	"CLINE_HUB_PORT",
	"CLINE_HUB_DISCOVERY_PATH",
	"CLINE_HUB_PATHNAME",
];
for (const variable of upstreamVariables)
	add(
		`upstream override ${variable} cannot redirect derivative`,
		["002", "053"],
		[
			step(
				"resolveStorage",
				{
					environment: { [variable]: "synthetic-upstream" },
					home: "synthetic-home",
				},
				{
					root: "synthetic-home/.cline-qb/data",
					upstreamReads: [],
					upstreamWrites: [],
					upstreamCreated: [],
					homeChanged: false,
				},
			),
		],
	);
for (const root of [
	".cline",
	".cline/nested",
	"symlink-to-.cline",
	"Documents/Cline",
	"OneDrive/Documents/Cline",
	"known-folder-Documents/Cline",
	"XDG-Documents/Cline",
	"Cline/Rules",
])
	add(
		`upstream root ${root} is never derivative storage`,
		["002", "053"],
		[
			step(
				"resolveStorage",
				{ override: root, seededCanary: "unchanged" },
				{
					outcome: "rejected",
					upstreamReads: [],
					upstreamWrites: [],
					upstreamCreated: [],
					canary: "unchanged",
					linkTargetUnchanged: true,
				},
			),
		],
	);
for (const ending of [
	"success",
	"assertion-failure",
	"timeout",
	"cancellation",
])
	add(
		`verification isolation survives ${ending}`,
		["071"],
		[
			step(
				"launchVerification",
				{
					ending,
					home: "synthetic-home",
					workspace: "synthetic-workspace",
					discovery: "synthetic-discovery",
					port: 0,
					inheritCredentials: false,
				},
				{
					initializedAfterIsolation: true,
					childHome: "synthetic-home",
					operatorCredentialReads: 0,
					operatorHubAttachments: 0,
					externalCanaries: "unchanged",
					newExternalFiles: [],
					cleanupOnlyOwned: true,
				},
			),
		],
	);
for (const source of [
	"fresh",
	"legacy-credentials",
	"cached-flags",
	"environment",
])
	add(
		`SDK provider safeguards under ${source}`,
		["016", "017", "018"],
		[
			step(
				"selectProvider",
				{ source, selected: "excluded-hosted-provider" },
				{
					outcome: "blocked",
					prohibitedRequests: 0,
					fallback: null,
					upstreamDataChanged: false,
				},
			),
			step(
				"selectProvider",
				{
					source,
					selected: "explicit-direct",
					credentials: "valid-fixture",
					proxy: "fixture-proxy",
				},
				{
					outcome: "ready",
					selected: "explicit-direct",
					proxy: "fixture-proxy",
					clineAccountRequired: false,
				},
			),
		],
	);
for (const credential of ["missing", "invalid"])
	add(
		`direct provider ${credential} credentials never select fallback`,
		["018"],
		[
			step(
				"selectProvider",
				{ selected: "explicit-direct", credentials: credential },
				{
					outcome: "blocked",
					actionable: true,
					fallback: null,
					prohibitedRequests: 0,
				},
			),
		],
	);
export const p1ContractCases: readonly ContractCase[] = cases;

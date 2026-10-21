// SPDX-License-Identifier: Apache-2.0
import type { AgentRuntimeConfig } from "@cline/shared";

export interface CompletionScope {
	workspaceId: string;
	sessionId: string;
	turnId: string;
}

/** Trusted host observations. Never populate this object from model tool arguments. */
export interface CompletionEvidence {
	scope: CompletionScope;
	trust: "verified" | "invalid" | "unavailable";
	policyDigest: string;
	fingerprint: string;
	continuationLimit: number;
	infrastructureReady: boolean;
	audit: {
		pending: number;
		rejected: number;
		quarantined: number;
		lost: number;
	};
	development: boolean;
	codeChanged: boolean;
	verification: {
		configured: boolean;
		requiredIds: readonly string[];
		records: readonly {
			id: string;
			status: "passed" | "failed";
			fingerprint: string;
			policyDigest: string;
		}[];
	};
	decision: "recorded" | "attested-none" | "missing";
	title: string;
	requestFirstLine: string;
	phaseCloseRequired: boolean;
	phaseReview: "verified" | "missing" | "invalid";
}

export type CompletionGate = NonNullable<AgentRuntimeConfig["completionGate"]>;

/** Each host turn owns its gate and supplies already authenticated evidence. */
export function createCompletionGate(
	scope: CompletionScope,
	readEvidence: () => Promise<CompletionEvidence>,
): CompletionGate {
	const expected = { ...scope };
	let previousObligations = "";
	let unchangedAttempts = 0;
	return async (context) => {
		const blocked = (diagnostic: string) => ({
			outcome: "blocked" as const,
			diagnostic,
		});
		try {
			const state = await readEvidence();
			if (
				!Object.values(expected).every(
					(value) => typeof value === "string" && value.trim(),
				) ||
				state.scope.workspaceId !== expected.workspaceId ||
				state.scope.sessionId !== expected.sessionId ||
				state.scope.turnId !== expected.turnId
			) {
				return blocked(
					"Completion evidence scope does not match the host turn. Restore the authenticated turn context.",
				);
			}
			if (state.trust !== "verified") {
				return blocked(
					"Completion trust is not verified. Restore the signed host context before resuming work.",
				);
			}
			if (
				!/^[a-f0-9]{64}$/i.test(state.policyDigest) ||
				!/^[a-f0-9]{64}$/i.test(state.fingerprint) ||
				!Number.isSafeInteger(state.continuationLimit) ||
				state.continuationLimit < 1 ||
				state.continuationLimit > 3
			) {
				return blocked(
					"Completion policy or source fingerprint is invalid. Reload the signed workspace policy.",
				);
			}
			if (state.infrastructureReady !== true) {
				return blocked(
					"Completion infrastructure is unavailable. Restore the host connection before resuming work.",
				);
			}
			const auditKinds = [
				"pending",
				"rejected",
				"quarantined",
				"lost",
			] as const;
			if (
				auditKinds.some(
					(kind) =>
						!Number.isSafeInteger(state.audit[kind]) || state.audit[kind] < 0,
				)
			) {
				return blocked(
					"Audit evidence is invalid. Recover the durable audit journal before resuming work.",
				);
			}
			const outstandingAudit = auditKinds.filter(
				(kind) => state.audit[kind] > 0,
			);
			if (outstandingAudit.length) {
				return blocked(
					`Mandatory audit is unresolved (${outstandingAudit.join(", ")}). Preserve evidence and use supported audit recovery before completion.`,
				);
			}
			if (
				typeof state.development !== "boolean" ||
				typeof state.codeChanged !== "boolean" ||
				typeof state.phaseCloseRequired !== "boolean" ||
				(state.codeChanged && !state.development) ||
				!["recorded", "attested-none", "missing"].includes(state.decision)
			) {
				return blocked(
					"Completion classification is invalid. Refresh host-owned operation evidence.",
				);
			}

			const unmet: string[] = [];
			if (state.codeChanged || state.phaseCloseRequired) {
				const { requiredIds, records, configured } = state.verification;
				if (
					configured !== true ||
					requiredIds.length === 0 ||
					requiredIds.some((id) => typeof id !== "string" || !id.trim()) ||
					new Set(requiredIds).size !== requiredIds.length
				) {
					return blocked(
						"Required verification is not configured. Register the signed workspace verification policy.",
					);
				}
				for (const id of [...requiredIds].sort()) {
					const matching = records.filter((record) => record.id === id);
					// Ambiguous evidence is not proof, even if one of the records passed.
					if (
						matching.length !== 1 ||
						matching[0].status !== "passed" ||
						matching[0].fingerprint !== state.fingerprint ||
						matching[0].policyDigest !== state.policyDigest
					) {
						unmet.push(
							`Run required verification ${id} successfully for the current source fingerprint and policy`,
						);
					}
				}
			}
			if (state.development && state.decision === "missing") {
				unmet.push(
					"Record the design decision or explicitly attest that no decision was made",
				);
			}
			const title = state.title.trim();
			if (
				!title ||
				title.toLowerCase() === "user prompt" ||
				title === state.requestFirstLine.trim()
			) {
				unmet.push("Set a summary turn title through the host title tool");
			}
			if (state.phaseCloseRequired) {
				if (state.phaseReview === "invalid") {
					return blocked(
						"Phase review evidence is invalid. Obtain a verified review for the current closing state.",
					);
				}
				if (state.phaseReview !== "verified")
					unmet.push("Obtain the required phase-closing HV agreement");
			}
			// A successful completion cannot precede another tool that changes source
			// or audit state. Ask the model to finish ordinary work in a separate turn.
			if (
				context.source === "tool" &&
				context.candidate.content.filter((part) => part.type === "tool-call")
					.length > 1
			) {
				unmet.push(
					"Run ordinary tools first, then submit the completion tool alone",
				);
			}
			if (!unmet.length) {
				previousObligations = "";
				unchangedAttempts = 0;
				return { outcome: "allow" };
			}
			const key = JSON.stringify([
				state.fingerprint,
				state.policyDigest,
				unmet,
			]);
			unchangedAttempts =
				key === previousObligations ? unchangedAttempts + 1 : 1;
			previousObligations = key;
			const diagnostic = unmet.join("; ") + ".";
			return unchangedAttempts >= state.continuationLimit
				? blocked(
						`Completion obligations unchanged after ${unchangedAttempts} attempts. ${diagnostic}`,
					)
				: { outcome: "continue", diagnostic };
		} catch {
			return blocked(
				"Unable to read valid host completion evidence. Restore the authenticated host connection before resuming work.",
			);
		}
	};
}

export {
	type GovernedPluginHost,
	loadVerifiedPluginHost,
} from "./plugin-host-loader.js";
export {
	type InstalledPlugin,
	type PluginInstallationBinding,
	type PreparedPluginInstallation,
	preparePluginInstallation,
} from "./plugin-installation.js";
export {
	createRequiredModelGate,
	type RequiredModelContextSource,
} from "./required-model-policy.js";
export {
	bootstrapGovernedPlugin,
	type TrustedPluginBootstrapOptions,
} from "./trusted-plugin-bootstrap.js";
export {
	createTurnCompletionController,
	type HostCompletionPolicy,
	type HostTurnObservations,
	type RecordedVerification,
	type TurnCompletionOptions,
} from "./turn-completion.js";
export {
	type HostVerificationPolicy,
	parseTestCounts,
	runVerification,
	selectVerificationChecks,
	type TestCounts,
	type VerificationCheck,
	VerificationError,
	type VerificationRecord,
	type VerificationRunOptions,
} from "./verification-runner.js";
export {
	captureWorkspaceFingerprint,
	changedSourcePaths,
	type FingerprintOptions,
	type SourceFingerprintFile,
	type WorkspaceFingerprint,
	WorkspaceFingerprintError,
} from "./workspace-fingerprint.js";

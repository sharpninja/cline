// SPDX-License-Identifier: Apache-2.0
import { createCompletionGate, type CompletionEvidence, type CompletionGate, type CompletionScope } from "./index.js";
import { captureWorkspaceFingerprint, type WorkspaceFingerprint } from "./workspace-fingerprint.js";
import { runVerification, selectVerificationChecks, VerificationError, type HostVerificationPolicy } from "./verification-runner.js";

export interface HostCompletionPolicy extends HostVerificationPolicy {
  document: HostVerificationPolicy["document"] & {
    policy: HostVerificationPolicy["document"]["policy"] & { continuationLimit: number };
  };
}
/** These observations must be read from the bound host lifecycle and supported MCP reads. */
export type HostTurnObservations = Pick<CompletionEvidence,
  "scope" | "trust" | "infrastructureReady" | "audit" | "decision" | "title" | "phaseCloseRequired" | "phaseReview">;
export type RecordedVerification = Readonly<Awaited<ReturnType<typeof runVerification>> & { scope: CompletionScope }>;
export interface TurnCompletionOptions {
  workspacePath: string;
  scope: CompletionScope;
  requestFirstLine: string;
  /** Capture before ingress; on resume restore the original trusted baseline, never recapture it. */
  baseline: WorkspaceFingerprint;
  readPolicy(): Promise<HostCompletionPolicy>;
  readState(): Promise<HostTurnObservations>;
  /** Resolve only after matching persisted readback; reject on unavailable or unverified persistence. */
  recordVerification(result: RecordedVerification): Promise<void>;
  timeoutMs?: number;
}

/**
 * One controller per host turn. Its closures and receipts never enter model tool
 * arguments. Checks run once per current state unless explicitly retried by the
 * host. Restart must restore the original baseline; verification is safely rerun.
 */
export function createTurnCompletionController(options: TurnCompletionOptions) {
  const { workspacePath, requestFirstLine, readPolicy, readState, recordVerification, timeoutMs } = options;
  const baseline = structuredClone(options.baseline);
  const scope = Object.freeze({ workspaceId: options.scope.workspaceId, sessionId: options.scope.sessionId, turnId: options.scope.turnId });
  if (Object.values(scope).some(value => typeof value !== "string" || !value.trim()) ||
    typeof requestFirstLine !== "string" || typeof recordVerification !== "function") throw new VerificationError("turn_configuration");
  let closed = false;
  const cancellation = new AbortController();
  let queue: Promise<unknown> = Promise.resolve();
  let attempt: { key: string; result: RecordedVerification; persisted: boolean } | undefined;

  const sameScope = (other: CompletionScope) => other && other.workspaceId === scope.workspaceId &&
    other.sessionId === scope.sessionId && other.turnId === scope.turnId;
  const open = () => { if (closed) throw new VerificationError("turn_closed"); };
  function exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(async () => { open(); return operation(); });
    queue = result.catch(() => undefined);
    return result;
  }
  function eligible(state: HostTurnObservations): boolean {
    return state.trust === "verified" && state.infrastructureReady === true &&
      ["pending", "rejected", "quarantined", "lost"].every(kind => state.audit[kind as keyof typeof state.audit] === 0);
  }
  const keyFor = (fingerprint: string, digest: string, closing: boolean, ids: readonly string[]) =>
    JSON.stringify([fingerprint, digest, closing, ids]);

  async function snapshot() {
    open();
    const state = structuredClone(await readState());
    if (!sameScope(state.scope) || typeof state.phaseCloseRequired !== "boolean") throw new VerificationError("turn_scope");
    const policy = structuredClone(await readPolicy());
    if (!Number.isInteger(policy.document.policy.continuationLimit) || policy.document.policy.continuationLimit < 1 ||
      policy.document.policy.continuationLimit > 3) throw new VerificationError("policy_configuration");
    const current = await captureWorkspaceFingerprint({ workspacePath, policyDigest: policy.policyDigest });
    const selection = selectVerificationChecks(policy, baseline, current, state.phaseCloseRequired);
    open();
    return { state, policy, current, selection, key: keyFor(current.hash, policy.policyDigest, state.phaseCloseRequired, selection.checks.map(check => check.id)) };
  }

  async function verifySnapshot(observation: Awaited<ReturnType<typeof snapshot>>, force = false) {
    if (!eligible(observation.state)) throw new VerificationError("host_not_ready");
    if (!force && attempt?.key === observation.key) return attempt.result;
    const result = Object.freeze({ ...await runVerification({
      workspacePath, baseline, scope, readPolicy, phaseClosing: observation.state.phaseCloseRequired,
      signal: cancellation.signal, timeoutMs,
    }), scope });
    // Closing cancels execution but must not discard its original-turn receipt.
    // Record both success and failure before either can affect completion.
    attempt = { key: keyFor(result.fingerprint, result.policyDigest, observation.state.phaseCloseRequired, result.requiredIds), result, persisted: false };
    await recordVerification(result);
    open();
    attempt.persisted = true;
    return result;
  }

  const policyGate = createCompletionGate(scope, async (): Promise<CompletionEvidence> => {
    let observation = await snapshot();
    if (eligible(observation.state) && observation.selection.checks.length > 0) {
      await verifySnapshot(observation);
      // Check source, policy, audit, lifecycle and phase observations again after
      // processes and persistence callbacks. Stale receipts are not relabelled.
      observation = await snapshot();
    }
    const currentAttempt = attempt?.key === observation.key ? attempt : undefined;
    const { state, policy, current, selection } = observation;
    return {
      ...state, scope, requestFirstLine, policyDigest: policy.policyDigest, fingerprint: current.hash,
      continuationLimit: policy.document.policy.continuationLimit,
      infrastructureReady: state.infrastructureReady && (!currentAttempt || currentAttempt.persisted),
      development: selection.development, codeChanged: selection.codeChanged,
      verification: { configured: true, requiredIds: selection.checks.map(check => check.id),
        records: currentAttempt?.persisted ? currentAttempt.result.records.filter(record => sameScope(record.scope)) : [] },
    };
  });

  const completionGate: CompletionGate = async context => {
    try { return await exclusive(async () => { const verdict = await policyGate(context); open(); return verdict; }); }
    catch { return { outcome: "blocked", diagnostic: "Host turn evidence is unavailable or closed. Restore the bound lifecycle and verification evidence before completing." }; }
  };
  return Object.freeze({
    completionGate,
    /** Explicit host recovery/retry, not a model-supplied receipt or policy override. */
    verify: () => exclusive(async () => verifySnapshot(await snapshot(), true)),
    close: async () => { closed = true; cancellation.abort(); await queue; },
  });
}
// SPDX-License-Identifier: Apache-2.0
import { AgentRuntime } from "@cline/agents";
import type { AgentModel } from "@cline/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureWorkspaceFingerprint } from "./workspace-fingerprint.js";
import { createTurnCompletionController, type HostCompletionPolicy, type HostTurnObservations } from "./turn-completion.js";

describe("host completion with actual source and command evidence", () => {
  let root: string;
  let state: HostTurnObservations;
  let policy: HostCompletionPolicy;
  let baseline: Awaited<ReturnType<typeof captureWorkspaceFingerprint>>;
  const digest = "a".repeat(64);
  const saved = vi.fn(async (_result: unknown) => {});
  const model = (): AgentModel => ({ stream: vi.fn(async function* () {
    yield { type: "text-delta" as const, text: "FINAL_RESULT" };
    yield { type: "finish" as const, reason: "stop" as const };
  }) });
  const construct = () => createTurnCompletionController({ workspacePath: root, baseline, scope: state.scope,
    requestFirstLine: "Do the work", readPolicy: async () => policy, readState: async () => state, recordVerification: saved });
  const run = (controller: ReturnType<typeof construct>) => new AgentRuntime({ model: model(), completionGate: controller.completionGate }).run("Do the work");
  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), "qb-host-completion-"));
    await fs.writeFile(join(root, "source.ts"), "before");
    baseline = await captureWorkspaceFingerprint({ workspacePath: root, policyDigest: digest });
    state = { scope: { workspaceId: root, sessionId: "session", turnId: "turn" }, trust: "verified",
      infrastructureReady: true, audit: { pending: 0, rejected: 0, quarantined: 0, lost: 0 },
      decision: "attested-none", title: "Finish requested work", phaseCloseRequired: false, phaseReview: "missing" };
    policy = { policyDigest: digest, document: { workspacePath: root, policy: { continuationLimit: 3, checks: [{
      id: "unit", argv: [process.execPath, "-e", "console.log('Tests 1 passed (1)')"], cwd: ".", required: true,
      triggers: ["code"], scope: "turn", pathGlobs: [], suiteKind: "unit"
    }] } } };
    saved.mockReset(); saved.mockResolvedValue(undefined);
  });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it("runs verification and persists rooted receipts before actual runtime success", async () => {
    const controller = construct();
    await fs.writeFile(join(root, "source.ts"), "after");
    expect((await run(controller)).status).toBe("completed");
    expect(saved).toHaveBeenCalledOnce();
    expect(saved.mock.calls[0][0]).toMatchObject({ scope: state.scope, records: [{ status: "passed", scope: state.scope }] });
    await controller.close();
  });
  it("reuses only matching evidence and reruns after source changes", async () => {
    const controller = construct();
    await fs.writeFile(join(root, "source.ts"), "first");
    expect((await run(controller)).status).toBe("completed");
    expect((await run(controller)).status).toBe("completed");
    expect(saved).toHaveBeenCalledTimes(1);
    await fs.writeFile(join(root, "source.ts"), "second");
    expect((await run(controller)).status).toBe("completed");
    expect(saved).toHaveBeenCalledTimes(2);
  });
  it("rechecks signed policy and invalidates previous receipts after rotation", async () => {
    const controller = construct(); await fs.writeFile(join(root, "source.ts"), "after");
    expect((await run(controller)).status).toBe("completed");
    policy = { ...policy, policyDigest: "b".repeat(64) };
    expect((await run(controller)).status).toBe("completed");
    expect(saved).toHaveBeenCalledTimes(2);
  });
  it("does not run code commands for documentation-only or administrative work", async () => {
    const controller = construct();
    expect((await run(controller)).status).toBe("completed");
    await fs.writeFile(join(root, "README.md"), "documentation");
    expect((await run(controller)).status).toBe("completed");
    expect(saved).not.toHaveBeenCalled();
  });
  it("runs the phase matrix from trusted closure state even on an administrative turn", async () => {
    const controller = construct();
    state.phaseCloseRequired = true; state.phaseReview = "verified";
    expect((await run(controller)).status).toBe("completed");
    expect(saved).toHaveBeenCalledOnce();
  });
  it.each(["pending", "rejected", "quarantined", "lost"] as const)("blocks %s audit before launching commands", async kind => {
    const controller = construct(); await fs.writeFile(join(root, "source.ts"), "after");
    state.audit[kind] = 1;
    expect((await run(controller)).status).toBe("blocked");
    expect(saved).not.toHaveBeenCalled();
  });
  it("refuses foreign turn evidence without executing verification", async () => {
    const controller = construct(); await fs.writeFile(join(root, "source.ts"), "after");
    state = { ...state, scope: { ...state.scope, turnId: "other" } };
    expect((await run(controller)).status).toBe("blocked");
    expect(saved).not.toHaveBeenCalled();
  });
  it("blocks completion if the verified receipt cannot be durably recorded", async () => {
    const controller = construct(); await fs.writeFile(join(root, "source.ts"), "after");
    saved.mockRejectedValue(new Error("receipt backend unavailable"));
    expect((await run(controller)).status).toBe("blocked");
    expect(saved).toHaveBeenCalledOnce();
  });
  it("retains failed verification across bounded correction attempts without rerunning it", async () => {
    policy.document.policy.checks[0].argv = [process.execPath, "-e", "process.exit(7)"];
    const controller = construct(); await fs.writeFile(join(root, "source.ts"), "after");
    expect(await run(controller)).toMatchObject({ status: "blocked", iterations: 3 });
    expect(saved).toHaveBeenCalledOnce();
    expect(saved.mock.calls[0][0]).toMatchObject({ records: [{ status: "failed", exitCode: 7 }] });
  });
  it("serializes concurrent completion attempts rather than running duplicate checks", async () => {
    const controller = construct(); await fs.writeFile(join(root, "source.ts"), "after");
    const results = await Promise.all([run(controller), run(controller)]);
    expect(results.map(result => result.status)).toEqual(["completed", "completed"]);
    expect(saved).toHaveBeenCalledOnce();
  });
  it("retains a cancelled command receipt under the original identity while close drains", async () => {
    policy.document.policy.checks[0].argv = [process.execPath, "-e",
      "const fs=require('fs'); fs.mkdirSync('.mcpServer',{recursive:true}); fs.writeFileSync('.mcpServer/started','yes'); setInterval(()=>{},1000)"];
    const controller = construct(); await fs.writeFile(join(root, "source.ts"), "after");
    const settled = controller.verify().then(() => undefined, error => error);
    await vi.waitFor(async () => { await fs.stat(join(root, ".mcpServer/started")); }, { timeout: 3000 });
    await controller.close();
    expect(await settled).toBeInstanceOf(Error);
    expect(saved).toHaveBeenCalledOnce();
    expect(saved.mock.calls[0][0]).toMatchObject({ scope: state.scope, records: [{ status: "failed", reason: "cancelled", scope: state.scope }] });
  });
  it("revalidates sources after receipt persistence instead of relabelling old proof", async () => {
    const controller = construct(); await fs.writeFile(join(root, "source.ts"), "after");
    saved.mockImplementationOnce(async () => { await fs.writeFile(join(root, "source.ts"), "changed-during-persistence"); });
    expect(await run(controller)).toMatchObject({ status: "completed", iterations: 2 });
    expect(saved).toHaveBeenCalledTimes(2);
  });
  it("invalidates a closed turn and refuses new verification", async () => {
    const controller = construct(); await fs.writeFile(join(root, "source.ts"), "after");
    await controller.close();
    expect((await run(controller)).status).toBe("blocked");
    await expect(controller.verify()).rejects.toThrow("turn_closed");
    expect(saved).not.toHaveBeenCalled();
  });
});
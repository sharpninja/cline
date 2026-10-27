// SPDX-License-Identifier: Apache-2.0
// Observer discrimination only. No production import or completed suite registration.
import { expect, test } from "bun:test";
import { scenarios, runScenario, assertScenario, type Provider } from "./p1-desktop-admission.contract.fixture";
import { SyntheticScheduleHub, observeStoredSchedule, assertIntendedScheduleRejection,
  type HubDefect, type ScheduleControlEvidence } from "./p1-desktop-actual-schedule.fixture";

function independentCommandModel(defect: HubDefect = "none", acknowledgeOnly = false,
  capture: (evidence: ScheduleControlEvidence) => void = () => {}, unrelatedThrow = false): Provider {
  return async (input, dependencies) => {
    const identity = { workspaceRoot: "/synthetic-owned/" + input.context, id: input.context };
    const hub = new SyntheticScheduleHub(identity.workspaceRoot, defect);
    if (input.kind === "edit") hub.seed({ scheduleId: "existing", name: "Existing", workspaceRoot: identity.workspaceRoot,
      modelSelection: { providerId: input.raw.provider, modelId: input.raw.model } });
    try {
      const catalog = await dependencies.catalog(); hub.record("dependency-response", "catalog", catalog);
      if (unrelatedThrow) throw new TypeError("Deliberate unrelated consumer crash; not an observer rejection");
      // Input-only command consumer owns actual independent dependency writes/reads, never a Scenario/expected object.
      const consume = async (command: string, args: Record<string, unknown> = {}) => {
        if (acknowledgeOnly && (command === "create_routine_schedule" || command === "update_routine_schedule")) {
          return { schedule: { scheduleId: "echo-only", modelSelection: { providerId: args.provider, modelId: args.model } } };
        }
        if (command === "list_routine_schedules") {
          const read = await hub.command("schedule.list", {});
          return { schedules: read.payload.schedules };
        }
        if (command !== "create_routine_schedule" && command !== "update_routine_schedule") throw new Error("Unexpected independent command");
        const reply = await hub.command(command === "create_routine_schedule" ? "schedule.create" : "schedule.update", {
          scheduleId: args.schedule_id, name: args.name, workspaceRoot: args.workspace_root,
          modelSelection: { providerId: args.provider, modelId: args.model },
        });
        return { schedule: reply.payload.schedule };
      };
      const observed = await observeStoredSchedule(consume, hub,
        input.kind === "edit" ? "update_routine_schedule" : "create_routine_schedule",
        { schedule_id: input.kind === "edit" ? "existing" : undefined, name: "Synthetic",
          provider: input.raw.provider, model: input.raw.model, workspace_root: identity.workspaceRoot }, identity);
      await dependencies.commit(observed.kind, observed.pair, observed.context);
    } finally {
      const evidence = { trace: structuredClone(hub.trace), finalStorage: hub.snapshot() };
      capture(evidence);
      console.log(JSON.stringify({ kind: "ObserverInteractions", input, defect, acknowledgeOnly, unrelatedThrow, ...evidence }));
    }
  };
}
const controls = ["drop-write", "wrong-pair", "wrong-workspace", "missing-read", "read-before-write", "acknowledgement-only"] as const;
for (const kind of ["create", "edit"] as const) {
  const item = scenarios.find((item) => item.name === kind + ": exact explicit legacy pair")!;
  test(kind + " / new observer correct independent command model", async () => {
    const observed = await runScenario(item, independentCommandModel());
    assertScenario(item, observed);
    console.log(JSON.stringify({ scenario: item.name, mode: "ObserverMock", observed }));
  });
  for (const defect of controls) {
    test(kind + (defect === "acknowledgement-only" ? " / SAME assertions reject acknowledged input echo without storage" : " / SAME assertions reject actual observer dependency " + defect), async () => {
      assertScenario(item, await runScenario(item, independentCommandModel()));
      let evidence: ScheduleControlEvidence = { trace: [], finalStorage: [] };
      let observed: Awaited<ReturnType<typeof runScenario>> | undefined;
      let rejection: unknown;
      try {
        observed = await runScenario(item, independentCommandModel(defect === "acknowledgement-only" ? "none" : defect,
          defect === "acknowledgement-only", (value) => { evidence = value; }));
        assertScenario(item, observed);
      } catch (error) { rejection = error; }
      assertIntendedScheduleRejection(rejection, { kind, defect, evidence, observed, expectedEffects: item.expected.effects });
      console.log(JSON.stringify({ scenario: item.name, defect, rejected: true, rejection: String(rejection), evidence, observed }));
    });
    test(kind + " / control classifier rejects unrelated actual consumer throw for " + defect, async () => {
      let evidence: ScheduleControlEvidence = { trace: [], finalStorage: [] }; let unrelated: unknown;
      try {
        await runScenario(item, independentCommandModel(defect === "acknowledgement-only" ? "none" : defect,
          defect === "acknowledgement-only", (value) => { evidence = value; }, true));
      } catch (error) { unrelated = error; }
      expect(unrelated).toBeInstanceOf(TypeError);
      expect(() => assertIntendedScheduleRejection(unrelated, { kind, defect, evidence, expectedEffects: item.expected.effects }))
        .toThrow("control rejected: unrelated non-assertion exception");
      console.log(JSON.stringify({ scenario: item.name, defect, mode: "ObserverControlGuard", controlRejected: true,
        unrelated: String(unrelated), evidence }));
    });
  }
}
test("observer gate inventory retains two correct plus twelve rejection controls", () => {
  expect(["create", "edit"].map((kind) => scenarios.find((item) => item.name === kind + ": exact explicit legacy pair")).filter(Boolean)).toHaveLength(2);
  expect(controls).toHaveLength(6);
});


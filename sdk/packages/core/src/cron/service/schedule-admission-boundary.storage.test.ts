// SPDX-License-Identifier: Apache-2.0
import { AssertionError, fail, strictEqual } from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { HubScheduleCreateInput, ScheduleRecord } from "@cline/shared";
import { describe, it, vi } from "vitest";
import {
  admissionControls, admissionScenarios, assertAdmissionScenario,
  createAdmissionDependencies, runAdmissionModel,
  type AdmissionFault, type AdmissionInput,
} from "./schedule-admission-boundary.fixture";
import { HubScheduleService } from "./schedule-service";

// Only the ID mint is scripted. Scheduling service, SQLite transactions and rows
// are real. Admission/catalog/host publication stay test-only model boundaries;
// this binding does NOT prove a production host rejects a bad pair.
vi.mock("node:crypto", async () => ({
  ...(await vi.importActual<typeof import("node:crypto")>("node:crypto")),
  randomUUID: () => "fixture",
}));

function project(record: ScheduleRecord) {
  return {
    scheduleId: record.scheduleId, name: record.name,
    modelSelection: record.modelSelection as NonNullable<AdmissionInput["initial"]>["modelSelection"],
  };
}

async function bindStorage(input: AdmissionInput, fault?: AdmissionFault) {
  const directory = await mkdtemp(join(tmpdir(), "qb-schedule-storage-"));
  const service = new HubScheduleService({
    dbPath: join(directory, "cron.db"),
    specs: { cronSpecsDir: join(directory, "specs") },
    runtimeHandlers: {
      startSession: async () => { throw new Error("unexpected execution"); },
      sendSession: async () => { throw new Error("unexpected execution"); },
      abortSession: async () => { throw new Error("unexpected execution"); },
      stopSession: async () => { throw new Error("unexpected execution"); },
    },
  });
  const createInput = (name: string, pair: unknown): HubScheduleCreateInput => ({
    name, prompt: "synthetic prompt", workspaceRoot: directory,
    cronPattern: "0 * * * *", timezone: "UTC", enabled: false,
    modelSelection: pair as HubScheduleCreateInput["modelSelection"],
  });
  const rawRows: unknown[][] = [];
  const readDb = new DatabaseSync(join(directory, "cron.db"), { readOnly: true });
  try {
    if (input.initial) {
      service.createSchedule(createInput(input.initial.name, input.initial.modelSelection));
    }
    const deps = createAdmissionDependencies(input, fault);
    const real = {
      ...deps,
      snapshot() {
        const rows = readDb.prepare("SELECT * FROM cron_specs ORDER BY external_id").all();
        rawRows.push(rows);
        return rows.map(row => ({
          scheduleId: String(row.external_id), name: String(row.title),
          modelSelection: row.provider_id || row.model_id ? {
            providerId: String(row.provider_id ?? ""), modelId: String(row.model_id ?? ""),
          } : undefined,
        }));
      },
      get() {
        deps.journal.push(["store.get", input.scheduleId]);
        const record = service.getSchedule(input.scheduleId);
        return record ? project(record) : undefined;
      },
      persist(pair: unknown) {
        let next = structuredClone(pair) as { providerId: string; modelId: string } | undefined;
        if (fault === "cloud-fallback") next = { providerId: "cline", modelId: "cloud-default" };
        if (fault === "wrong-provider" && next) next.providerId = "foreign";
        if (fault === "wrong-model" && next) next.modelId = "foreign";
        if (fault === "partial-write" && next) next.modelId = input.initial?.modelSelection?.modelId ?? "";
        const record = input.operation === "create"
          ? service.createSchedule(createInput(input.name, next))
          : service.updateSchedule(input.scheduleId, { scheduleId: input.scheduleId, name: input.name, modelSelection: next });
        if (!record) throw new Error("actual service did not return the existing schedule");
        const returned = project(record);
        deps.journal.push(["store." + input.operation, structuredClone(returned)]);
        if (fault === "wrong-returned-pair" && returned.modelSelection) {
          returned.modelSelection = { ...returned.modelSelection, modelId: "foreign" };
        }
        return returned;
      },
    };
    const observed = await runAdmissionModel(input, fault, real);
    return { observed, rawRows };
  } finally {
    readDb.close();
    await service.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}

describe("P1 SAME schedule admission assertions with actual service/SQLite storage only", () => {
  for (const scenario of admissionScenarios) {
    it(scenario.id, async () => {
      const { observed, rawRows } = await bindStorage(structuredClone(scenario.input));
      assertAdmissionScenario(scenario, observed);
      console.log(JSON.stringify({ case: scenario.id, binding: "actual-SQLite/scripted-private-admission", observed, rawRows }));
    });
  }
  for (const control of admissionControls) {
    it(`rejects ${control.fault} for ${control.scenario}`, async () => {
      const scenario = admissionScenarios.find(row => row.id === control.scenario);
      if (!scenario) throw new Error("unknown input");
      // Incidental service/SQLite exceptions are outside the assertion catch.
      const { observed, rawRows } = await bindStorage(structuredClone(scenario.input), control.fault);
      let rejected = false;
      try { assertAdmissionScenario(scenario, observed); }
      catch (error) {
        if (!(error instanceof AssertionError)) throw error;
        strictEqual(error.code, "ERR_ASSERTION");
        rejected = true;
      }
      if (!rejected) fail("SAME assertions must reject the deliberate wrong storage interaction");
      console.log(JSON.stringify({ control, assertionRejected: rejected, binding: "actual-SQLite/scripted-private-admission", observed, rawRows }));
    });
  }
});

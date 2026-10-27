// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopModel } from "./p1-desktop-model.fixture";
import { assertScenario, observe, runScenario, scenarios, type Fault } from "./p1-desktop-scenarios.fixture";

const createMock = () => new DesktopModel();
describe("P1 desktop independent interaction gate (Mock only)", () => {
  for (const scenario of scenarios) {
    const ids = scenario.ac.map(id => "TEST-QB-" + String(id).padStart(3, "0")).join("/");
    test(ids + " " + scenario.name, async () => {
      const observation = await runScenario(scenario, createMock);
      console.log(JSON.stringify({ kind: "positive-interactions", name: scenario.name, ac: scenario.ac, uc: scenario.uc, flow: scenario.flow, observation }));
    });
    test(ids + " rejects interaction faults: " + scenario.name, async () => {
      const faults: Fault[] = ["drop-effect", "extra-delivery"];
      if (scenario.effects.length > 1) faults.push("reorder-effect");
      if (scenario.script.length) faults.push("omit-response", "wrong-response", "misroute-call");
      if (scenario.script.length > 1) faults.push("reorder-response");
      for (const fault of faults) {
        const observation = await observe(createMock(), scenario.input, scenario.script, fault);
        expect(() => assertScenario(scenario, observation)).toThrow();
        console.log(JSON.stringify({ kind: "rejected-interactions", name: scenario.name, fault, observation }));
      }
      if (scenario.badScript) {
        const observation = await observe(createMock(), scenario.input, scenario.badScript);
        expect(() => assertScenario(scenario, observation)).toThrow();
        console.log(JSON.stringify({ kind: "rejected-interactions", name: scenario.name, fault: "wrong-dependency-state", observation }));
      }
    });
  }
});

test("D ownership coverage: all 30 P1 plus staged 029/053, updater safeguard and UC1-5 both flows", () => {
  const required = [...Array.from({ length: 18 }, (_, i) => i + 1), ...Array.from({ length: 12 }, (_, i) => i + 61), 29, 53];
  for (const id of required) expect(scenarios.some(scenario => scenario.ac.includes(id))).toBe(true);
  for (const id of [1, 2, 3, 4, 5]) for (const flow of ["basic", "alternative"]) expect(scenarios.some(scenario => scenario.uc.includes(id) && scenario.flow === flow)).toBe(true);
  expect(scenarios.some(scenario => scenario.ac.includes(56))).toBe(true);
});

test("TEST-QB-071 actual synthetic canaries survive successful and failed assertions; no product imports", async () => {
  // Deliberately retain roots as evidence. No recursive cleanup or live-home access.
  const root = await mkdtemp(join(tmpdir(), "qb-d-mock-"));
  const upstream = join(root, "external-cline-canary");
  const task = join(root, "task-owned");
  await mkdir(upstream); await mkdir(task);
  const canary = "synthetic upstream bytes\r\nUnicode \u03b1\r\n";
  await writeFile(join(upstream, "preserve.txt"), canary);
  const before = await readdir(upstream);
  const scenario = scenarios.find(item => item.name === "trusted launch")!;
  await runScenario(scenario, createMock);
  const bad = await observe(createMock(), scenario.input, scenario.script, "extra-delivery");
  expect(() => assertScenario(scenario, bad)).toThrow();
  expect(await readdir(upstream)).toEqual(before);
  expect(await readFile(join(upstream, "preserve.txt"), "utf8")).toBe(canary);
  expect(await readdir(task)).toEqual([]);
  console.log(JSON.stringify({ kind: "actual-canary", root, byteIdentical: true, inventoryIdentical: true, productionLaunch: false }));
});


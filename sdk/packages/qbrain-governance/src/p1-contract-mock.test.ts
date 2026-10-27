// SPDX-License-Identifier: Apache-2.0
import assert, { AssertionError } from "node:assert/strict";
import {
	type ContractCase,
	p1ContractCases,
} from "./__fixtures__/p1-contract-cases";
import {
	type BoundaryFault,
	GovernanceModel,
} from "./__fixtures__/p1-governance-model";

/** Test-only observation port. This is NOT a replacement frozen runtime API.
 * Real adapters must drive the corresponding frozen host/plugin operations and
 * capture actual effects, identities and denied-call counts; never return these
 * expected observations themselves. assertScenario is shared without alteration.
 */
export interface ContractDriver {
	invoke(operation: string, input: Record<string, unknown>): Promise<unknown>;
	calls: { operation: string; input: Record<string, unknown> }[];
	finish(): Promise<void>;
}
export type DriverFactory = (scenario: ContractCase) => ContractDriver;

export async function assertScenario(
	scenario: ContractCase,
	driver: ContractDriver,
): Promise<void> {
	const frozenInput = structuredClone(
		scenario.steps.map((value) => value.input),
	);
	for (const [index, probe] of scenario.steps.entries()) {
		const input = structuredClone(probe.input);
		const result = await driver.invoke(probe.operation, input);
		assert.deepStrictEqual(
			result,
			probe.expected,
			`${scenario.name}: result at step ${index}`,
		);
		assert.deepStrictEqual(
			input,
			frozenInput[index],
			`${scenario.name}: mutated invocation input`,
		);
	}
	await driver.finish();
	assert.deepStrictEqual(
		driver.calls,
		scenario.steps.map((probe) => ({
			operation: probe.operation,
			input: probe.input,
		})),
		`${scenario.name}: ordered interaction trace`,
	);
	assert.deepStrictEqual(
		scenario.steps.map((value) => value.input),
		frozenInput,
		`${scenario.name}: fixture input was mutated`,
	);
}

type Fault = {
	step: number;
	kind: "omit" | "throw" | "interaction" | "input" | "corrupt";
	path?: readonly (string | number)[];
};
function leaves(
	value: unknown,
	path: (string | number)[] = [],
): (string | number)[][] {
	if (value === null || typeof value !== "object") return [path];
	if (Array.isArray(value))
		return value.length === 0
			? [path]
			: value.flatMap((entry, index) => leaves(entry, [...path, index]));
	const entries = Object.entries(value);
	return entries.length === 0
		? [path]
		: entries.flatMap(([key, entry]) => leaves(entry, [...path, key]));
}
function corrupt(value: unknown, path: readonly (string | number)[]): unknown {
	if (path.length === 0) {
		if (typeof value === "boolean") return !value;
		if (typeof value === "number") return value + 1;
		if (typeof value === "string") return `${value}:WRONG`;
		if (value === null) return "wrong-nonempty";
		return ["unexpected-effect"];
	}
	const copy = structuredClone(value) as Record<string | number, unknown>;
	const [first, ...rest] = path;
	copy[first] = corrupt(copy[first], rest);
	return copy;
}
/** Runs the behavioral model without giving it the scenario or expected replies.
 * Existing comparator controls remain distinct from dependency/effect controls. */
export function scriptedDriver(
	scenario: ContractCase,
	fault?: Fault,
): ContractDriver {
	const model = new GovernanceModel();
	let position = 0;
	return {
		calls: model.calls,
		async invoke(operation, input) {
			const current = position++;
			const result = await model.invoke(operation, input);
			if (fault?.step === current) {
				switch (fault.kind) {
					case "omit":
						return undefined;
					case "throw":
						throw new Error("SCRIPTED_BOUNDARY_EXCEPTION");
					case "interaction":
						model.calls[model.calls.length - 1].operation =
							"unauthorized-extra-effect";
						break;
					case "input":
						input.unexpectedMutation = true;
						break;
					case "corrupt":
						return corrupt(result, fault.path ?? []);
				}
			}
			return result;
		},
		async finish() {
			await model.finish();
			assert.equal(
				position,
				scenario.steps.length,
				"Unconsumed required mock interactions",
			);
		},
	};
}
export function independentDriver(fault?: BoundaryFault): GovernanceModel {
	return new GovernanceModel(fault);
}

export function negativeControls(scenario: ContractCase): Fault[] {
	return scenario.steps.flatMap((probe, index) => [
		{ step: index, kind: "omit" as const },
		{ step: index, kind: "throw" as const },
		{ step: index, kind: "interaction" as const },
		{ step: index, kind: "input" as const },
		...leaves(probe.expected).map((path) => ({
			step: index,
			kind: "corrupt" as const,
			path,
		})),
	]);
}
export async function rejectNegative(
	scenario: ContractCase,
	control: Fault,
): Promise<void> {
	await assert.rejects(
		() => assertScenario(scenario, scriptedDriver(scenario, control)),
		(error) =>
			control.kind === "throw"
				? error instanceof Error &&
					error.message === "SCRIPTED_BOUNDARY_EXCEPTION"
				: error instanceof AssertionError,
		`${scenario.name}: negative control ${control.kind}/${control.step}/${control.path?.join(".") ?? ""}`,
	);
}
export async function proveMockContracts(): Promise<void> {
	let passed = 0;
	let failed = 0;
	let negativeRejected = 0;
	let boundaryRejected = 0;
	let capturedDependencyCalls = 0;
	let capturedEffects = 0;
	const failures: unknown[] = [];
	const interactionEvidence = new Map<string, unknown>();
	for (const scenario of p1ContractCases) {
		try {
			const observed = independentDriver();
			await assertScenario(scenario, observed);
			for (const control of dependencyControls(observed)) {
				await rejectBoundary(scenario, control);
				boundaryRejected++;
			}
			capturedDependencyCalls += observed.dependencies.length;
			capturedEffects += observed.effects.length;
			for (const capture of observed.stepCaptures)
				if (!interactionEvidence.has(capture.operation))
					interactionEvidence.set(capture.operation, capture);
			for (const control of negativeControls(scenario)) {
				await rejectNegative(scenario, control);
				negativeRejected++;
			}
			passed++;
		} catch (error) {
			failed++;
			failures.push({
				scenario: scenario.name,
				requirements: scenario.requirements,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	// Operational receipts are serialized by PowerShell; this native JS object is
	// merely test stdout, never a handwritten wire or persisted project record.
	console.log({
		lane: "independent-contract-mocks",
		scenarios: p1ContractCases.length,
		passed,
		failed,
		skipped: 0,
		negativeRejected,
		boundaryRejected,
		capturedDependencyCalls,
		capturedEffects,
		productionBound: false,
	});
	console.dir(
		{
			requirementIds: [
				...new Set(
					p1ContractCases.flatMap((scenario) => scenario.requirements),
				),
			].sort(),
			interactionEvidence: [...interactionEvidence.values()],
		},
		{ depth: null },
	);
	for (const failure of failures) console.error(failure);
	if (failed) process.exitCode = 1;
}

if (process.argv.includes("--mock-proof")) {
	await proveMockContracts();
} else {
	const { describe, it } = await import("vitest");
	describe("P1 canonical SDK contract mock gate (not production evidence)", () => {
		for (const scenario of p1ContractCases) {
			it(`${scenario.requirements.join("/")} ${scenario.name}`, async () => {
				const observed = independentDriver();
				await assertScenario(scenario, observed);
				for (const control of dependencyControls(observed))
					await rejectBoundary(scenario, control);
			});
			it(`${scenario.name}: rejects wrong, missing, exception and interaction controls`, async () => {
				for (const control of negativeControls(scenario))
					await rejectNegative(scenario, control);
			});
		}
	});
}

export function dependencyControls(model: GovernanceModel): BoundaryFault[] {
	return model.stepCaptures.flatMap((capture, step) => [
		...capture.dependencies.flatMap((_call, dependencyIndex) =>
			(["wrong", "omitted", "reordered", "callback-omitted"] as const).map(
				(kind) => ({ step, dependencyIndex, kind }),
			),
		),
		...(capture.effects.length
			? [{ step, kind: "side-effect-omitted" as const }]
			: []),
	]);
}
export async function rejectBoundary(
	scenario: ContractCase,
	control: BoundaryFault,
): Promise<void> {
	await assert.rejects(
		() => assertScenario(scenario, independentDriver(control)),
		(error) => error instanceof AssertionError,
		`${scenario.name}: behavioral boundary ${control.step}/${control.dependencyIndex ?? "effect"}/${control.kind}`,
	);
}

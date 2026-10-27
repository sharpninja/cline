import { AssertionError, deepStrictEqual } from "node:assert/strict";
import { describe, expect, it } from "vitest";
import { assertPath, observePath, pathVectors, type PathPort } from "./path-contract.fixture";

// Independent input-only model. No fixture/expected/case-id argument is accepted.
function model(separator: string, fault: "none" | "result" | "request" | "missing" | "duplicate" = "none"): PathPort {
	const calls: string[] = [];
	return {
		calls,
		convert(input) {
			if (fault !== "missing") calls.push(fault === "request" ? input + "!" : input);
			if (fault === "duplicate") calls.push(input);
			let output = "";
			for (const character of input) output += character === separator ? "/" : character;
			return fault === "result" ? output + "!" : output;
		},
	};
}
function rejected(run: () => void) {
	let error: unknown;
	try { run(); } catch (caught) { error = caught; }
	expect(error).toBeInstanceOf(AssertionError);
	expect((error as AssertionError).code).toBe("ERR_ASSERTION");
	expect((error as Error).message).toContain("PATH_CONTRACT:");
}

describe("original path separator assertion prerequisite", () => {
	for (const vector of pathVectors) {
		it(vector.id + " correct input-only model", () => {
			assertPath(vector, observePath(model(vector.separator), vector.input));
		});
		for (const fault of ["result", "request", "missing", "duplicate"] as const) {
			it(vector.id + " rejects " + fault + " through SAME contract", () => {
				rejected(() => assertPath(vector, observePath(model(vector.separator, fault), vector.input)));
			});
		}
	}
	it("negative-control qualifier refuses incidental exceptions and success", () => {
		for (const run of [() => {}, () => { throw new Error("PATH_CONTRACT: incidental"); }, () => deepStrictEqual(1, 2)]) {
			expect(() => rejected(run)).toThrow();
		}
	});
});

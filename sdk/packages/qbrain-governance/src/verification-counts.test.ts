// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { parseTestCounts } from "./verification-runner";

const tap = (pass = 5, fail = 0, cancelled = 0, skip = 0, todo = 0) =>
	`TAP version 13\n# tests ${pass + fail + cancelled + skip + todo}\n# suites 0\n# pass ${pass}\n# fail ${fail}\n# cancelled ${cancelled}\n# skipped ${skip}\n# todo ${todo}\n# duration_ms 12.3`;
const rust = (status = "ok", pass = 26, fail = 0, ignored = 0, filtered = 0) =>
	`test result: ${status}. ${pass} passed; ${fail} failed; ${ignored} ignored; 0 measured; ${filtered} filtered out; finished in 0.42s`;
const prefix = (text: string, wrapper: string) =>
	text
		.split("\n")
		.map((line) => wrapper + line)
		.join("\n");

describe("verification summaries from required command forms", () => {
	it("recognizes Rust after a real workspace wrapper without stripping the native header", () => {
		expect(
			parseTestCounts(prefix(rust(), "@cline/code test:native: ")),
		).toEqual({ passed: 26, failed: 0, skipped: 0, total: 26 });
	});
	it.each([
		"@cline/core test:unit: ",
		"claude-dev test:vitest: ",
		"@cline/core:test:unit       | ",
		"@cline/code test: @cline/agents test: ",
	])("recognizes Bun workspace wrapper %s without counting file summaries", (wrapper) => {
		expect(
			parseTestCounts(
				prefix("Test Files 9 passed (9)\nTests 233 passed (233)", wrapper),
			),
		).toEqual({ passed: 233, failed: 0, skipped: 0, total: 233 });
	});
	it("retains failures and skips across mixed workspace summaries with ANSI/CRLF", () => {
		expect(
			parseTestCounts(
				"\x1b[32m@cline/agents test: \x1b[0mTests 233 passed (233)\r\n@cline/core test:unit: Tests 2 failed | 3040 passed | 70 skipped (3112)\r\n",
			),
		).toEqual({ passed: 3273, failed: 2, skipped: 70, total: 3345 });
	});
	it("preserves Bun native counts beneath a workspace wrapper", () => {
		expect(
			parseTestCounts(
				prefix(
					"26 pass\n6 skip\n0 fail\n51 expect() calls\nRan 32 tests across 5 files.",
					"@cline/code test: ",
				),
			),
		).toEqual({ passed: 26, failed: 0, skipped: 6, total: 32 });
	});
	it("parses a complete Node TAP footer", () => {
		expect(parseTestCounts(tap())).toEqual({
			passed: 5,
			failed: 0,
			skipped: 0,
			total: 5,
		});
	});
	it("treats cancelled TAP tests as failed and todo tests as skipped", () => {
		expect(parseTestCounts(tap(2, 1, 3, 4, 5))).toEqual({
			passed: 2,
			failed: 4,
			skipped: 9,
			total: 15,
		});
	});
	it("keeps interleaved workspace TAP footers separate", () => {
		const first = prefix(tap(2), "@cline/one test: ").split("\n");
		const second = prefix(tap(3, 1), "@cline/two test: ").split("\n");
		expect(
			parseTestCounts(first.flatMap((line, i) => [line, second[i]]).join("\n")),
		).toEqual({ passed: 5, failed: 1, skipped: 0, total: 6 });
	});
	it("accepts sequential complete TAP runs without overwriting counts", () => {
		expect(parseTestCounts(`${tap(2)}\n${tap(3)}`)).toEqual({
			passed: 5,
			failed: 0,
			skipped: 0,
			total: 5,
		});
	});
	it("ignores indented nested TAP diagnostics rather than double-counting tests", () => {
		expect(parseTestCounts(`${prefix(tap(2), "    ")}\n${tap(3)}`)).toEqual({
			passed: 3,
			failed: 0,
			skipped: 0,
			total: 3,
		});
	});
	it("parses native Rust including empty doc-test groups", () => {
		expect(parseTestCounts(`${rust()}\n${rust("ok", 0)}`)).toEqual({
			passed: 26,
			failed: 0,
			skipped: 0,
			total: 26,
		});
	});
	it("keeps ignored and filtered-out Rust tests visible as skipped", () => {
		expect(parseTestCounts(rust("FAILED", 2, 1, 3, 4))).toEqual({
			passed: 2,
			failed: 1,
			skipped: 7,
			total: 10,
		});
	});
	it.each([
		"Tests 1 passed | 0 unknown (1)",
		"Tests 1 passed | 0 passed (1)",
		"Tests 1 passed (2)",
		"Tests 9007199254740992 passed (9007199254740992)",
		tap().replace("# fail 0\n", ""),
		tap().replace("# tests 5", "# tests 4"),
		tap().replace("# skipped 0", "# skipped -1"),
		tap().replace("# pass 5", "# pass 5\n# pass 5"),
		`${tap().replace("# todo 0", "")}\n${tap(2)}`,
		rust("ok", 2, 1),
		rust("FAILED", 2, 0),
		"test result: ok. truncated",
	])("refuses malformed or incomplete footer even alongside a valid summary (%s)", (bad) => {
		expect(parseTestCounts(`Tests 1 passed (1)\n${bad}`)).toBeUndefined();
	});
	it("cannot assemble a complete TAP footer from two incomplete workspace footers", () => {
		expect(
			parseTestCounts(
				"@cline/one test: # tests 5\n@cline/two test: # pass 5\n@cline/two test: # fail 0\n@cline/two test: # cancelled 0\n@cline/two test: # skipped 0\n@cline/two test: # todo 0",
			),
		).toBeUndefined();
	});
	it.each([
		"Test Suites: 2 passed, 2 total",
		"Test Files 2 passed (2)",
		"Exited with code 0",
		"ok 1 - case",
		"running 26 tests",
	])("does not accept non-summary text %s", (text) => {
		expect(parseTestCounts(text)).toBeUndefined();
	});
});

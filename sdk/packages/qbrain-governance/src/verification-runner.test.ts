// SPDX-License-Identifier: Apache-2.0

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type HostVerificationPolicy,
	parseTestCounts,
	runVerification,
	selectVerificationChecks,
	type VerificationCheck,
} from "./verification-runner.js";
import { captureWorkspaceFingerprint } from "./workspace-fingerprint.js";

describe("TEST-QB-011: signed verification selection and execution", () => {
	let root: string;
	let policy: HostVerificationPolicy;
	const digest = "a".repeat(64);
	const capture = () =>
		captureWorkspaceFingerprint({ workspacePath: root, policyDigest: digest });
	const write = async (path: string, text: string) => {
		await fs.mkdir(join(root, path, ".."), { recursive: true });
		await fs.writeFile(join(root, path), text);
	};
	function check(
		id: string,
		overrides: Partial<VerificationCheck> = {},
	): VerificationCheck {
		return {
			id,
			argv: [process.execPath, "-e", "console.log('Tests 1 passed (1)')"],
			cwd: ".",
			required: true,
			scope: "turn",
			suiteKind: "unit",
			triggers: ["code"],
			pathGlobs: [],
			...overrides,
		};
	}
	const options = (baseline: Awaited<ReturnType<typeof capture>>) => ({
		workspacePath: root,
		baseline,
		scope: { workspaceId: root, sessionId: "session", turnId: "turn" },
		readPolicy: async () => policy,
		timeoutMs: 5000,
	});
	beforeEach(async () => {
		root = await fs.mkdtemp(join(tmpdir(), "qb-verification-"));
		policy = {
			policyDigest: digest,
			document: { workspacePath: root, policy: { checks: [check("unit")] } },
		};
		await write("pkg/source.ts", "original");
	});
	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	it("selects package checks from source ownership even when the source is not a test file", async () => {
		const before = await capture();
		await write("pkg/source.ts", "changed");
		policy.document.policy.checks = [
			check("root"),
			check("pkg-unit", { pathGlobs: ["pkg/**"] }),
			check("other", { pathGlobs: ["other/**"] }),
			check("e2e", { scope: "phaseGate" }),
			check("optional", { required: false }),
		];
		expect(
			selectVerificationChecks(
				policy,
				before,
				await capture(),
				false,
			).checks.map((value) => value.id),
		).toEqual(["pkg-unit", "root"]);
	});
	it("runs the cumulative required matrix at phase scope even without a new turn edit", async () => {
		policy.document.policy.checks.push(
			check("e2e", { scope: "phaseGate", pathGlobs: ["other/**"] }),
		);
		const before = await capture();
		expect(
			selectVerificationChecks(policy, before, before, true).checks.map(
				(value) => value.id,
			),
		).toEqual(["e2e", "unit"]);
	});
	it("administrative and documentation-only changes do not invent code checks", async () => {
		const before = await capture();
		expect(
			selectVerificationChecks(policy, before, before, false).checks,
		).toEqual([]);
		await write("README.md", "docs");
		const selection = selectVerificationChecks(
			policy,
			before,
			await capture(),
			false,
		);
		expect(selection).toMatchObject({
			development: true,
			codeChanged: false,
			checks: [],
		});
	});
	it("fails when code changes have no applicable mandatory check", async () => {
		const before = await capture();
		await write("pkg/source.ts", "changed");
		policy.document.policy.checks = [
			check("not-applicable", { pathGlobs: ["other/**"] }),
		];
		expect(() =>
			selectVerificationChecks(policy, before, before, true),
		).not.toThrow();
		expect(() =>
			selectVerificationChecks(policy, before, { ...before, files: [] }, false),
		).toThrow("policy_configuration");
		await expect(runVerification(options(before))).rejects.toThrow(
			"policy_configuration",
		);
	});
	it("matches trigger and source ownership on the same changed path", async () => {
		const before = await capture();
		await write("pkg/source.ts", "changed");
		await write("other/README.md", "docs");
		policy.document.policy.checks = [
			check("root"),
			check("other-code", { pathGlobs: ["other/**"] }),
			check("other-doc", { triggers: ["doc"], pathGlobs: ["other/**"] }),
		];
		expect(
			selectVerificationChecks(
				policy,
				before,
				await capture(),
				false,
			).checks.map((value) => value.id),
		).toEqual(["other-doc", "root"]);
	});
	it("fails closed for malformed executable values", async () => {
		const before = await capture();
		await write("pkg/source.ts", "changed");
		policy.document.policy.checks[0].argv = [42 as unknown as string];
		await expect(runVerification(options(before))).rejects.toThrow(
			"policy_configuration",
		);
	});
	it("requires every root identity and captures scope before yielding", async () => {
		const before = await capture();
		await write("pkg/source.ts", "changed");
		const input = options(before);
		const running = runVerification(input);
		input.scope.turnId = "foreign";
		expect((await running).records[0].scope.turnId).toBe("turn");
		await expect(
			runVerification({ ...options(before), scope: {} as typeof input.scope }),
		).rejects.toThrow("policy_configuration");
	});
	it("retains a failed receipt when source access becomes invalid during a command", async () => {
		const before = await capture();
		await write("pkg/source.ts", "changed");
		policy.document.policy.checks = [
			check("a-invalid-source", {
				argv: [
					process.execPath,
					"-e",
					"require('fs').symlinkSync('/outside-not-in-workspace','unsafe'); console.log('Tests 1 passed (1)')",
				],
			}),
			check("b-later"),
		];
		const result = await runVerification(options(before));
		expect(result.records).toHaveLength(1);
		expect(result.records[0]).toMatchObject({
			status: "failed",
			reason: "source_unavailable",
		});
	});
	it("records cancellation without launching a pre-cancelled command", async () => {
		const before = await capture();
		await write("pkg/source.ts", "changed");
		const controller = new AbortController();
		controller.abort();
		const result = await runVerification({
			...options(before),
			signal: controller.signal,
		});
		expect(result.records[0]).toMatchObject({
			status: "failed",
			reason: "cancelled",
			exitCode: null,
		});
	});
	it.each([
		"../outside",
		"/absolute",
		"C:/outside",
	])("rejects unsafe cwd %s", async (cwd) => {
		const before = await capture();
		await write("pkg/source.ts", "changed");
		policy.document.policy.checks = [check("bad", { cwd })];
		await expect(runVerification(options(before))).rejects.toThrow(
			"policy_configuration",
		);
	});
	it("rejects duplicate identifiers and foreign policy workspace", async () => {
		const before = await capture();
		await write("pkg/source.ts", "changed");
		policy.document.policy.checks.push(check("UNIT"));
		await expect(runVerification(options(before))).rejects.toThrow(
			"policy_configuration",
		);
		policy.document.policy.checks = [check("unit")];
		policy.document.workspacePath = root + "-foreign";
		await expect(runVerification(options(before))).rejects.toThrow(
			"policy_configuration",
		);
	});
	it("executes literal arguments without shell substitution and records root identities", async () => {
		const before = await capture();
		await write("pkg/source.ts", "changed");
		policy.document.policy.checks = [
			check("literal", {
				argv: [
					process.execPath,
					"-e",
					"if(process.argv[1] !== '$(touch escaped)') process.exit(2); console.log('Tests 1 passed (1)')",
					"$(touch escaped)",
				],
			}),
		];
		const result = await runVerification(options(before));
		expect(result.records).toHaveLength(1);
		expect(result.records[0]).toMatchObject({
			status: "passed",
			scope: options(before).scope,
			policyDigest: digest,
			counts: { passed: 1, failed: 0, skipped: 0, total: 1 },
		});
		expect(result.records[0].fingerprint).toBe(result.fingerprint);
		await expect(fs.stat(join(root, "escaped"))).rejects.toThrow();
	});
	it("nonzero check exits stay failed and do not disappear from required IDs", async () => {
		const before = await capture();
		await write("pkg/source.ts", "changed");
		policy.document.policy.checks = [
			check("failure", { argv: [process.execPath, "-e", "process.exit(7)"] }),
		];
		const result = await runVerification(options(before));
		expect(result.requiredIds).toEqual(["failure"]);
		expect(result.records[0]).toMatchObject({ status: "failed", exitCode: 7 });
	});
	it.each([
		"console.log('Tests 1 skipped (1)')",
		"console.log('Tests 0 passed (0)')",
		"console.log('success without test evidence')",
	])("refuses invalid test success: %s", async (code) => {
		const before = await capture();
		await write("pkg/source.ts", "changed");
		policy.document.policy.checks = [
			check("invalid", { argv: [process.execPath, "-e", code] }),
		];
		expect((await runVerification(options(before))).records[0].status).toBe(
			"failed",
		);
	});
	it.each([
		["@cline/agents test: Tests 3 passed (3)", "passed"],
		[
			"# tests 2\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0",
			"passed",
		],
		[
			"test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s",
			"passed",
		],
		["@cline/agents test: Tests 2 passed | 1 skipped (3)", "failed"],
		["# tests 2\n# pass 2\n# fail 0", "failed"],
		[
			"test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 1 filtered out; finished in 0.01s",
			"failed",
		],
	])("checks actual subprocess evidence instead of accepting exit zero: %s", async (summary, status) => {
		const before = await capture();
		await write("pkg/source.ts", "changed");
		policy.document.policy.checks = [
			check("runner", {
				argv: [
					process.execPath,
					"-e",
					`console.log(${JSON.stringify(summary)})`,
				],
			}),
		];
		const record = (await runVerification(options(before))).records[0];
		expect(record.exitCode).toBe(0);
		expect(record.status).toBe(status);
		if (status === "failed")
			expect(record.reason).toBe("test_evidence_invalid");
		else expect(record.counts).toMatchObject({ failed: 0, skipped: 0 });
	});
	it("rejects success if a command changes source and stops issuing stale receipts", async () => {
		const before = await capture();
		await write("pkg/source.ts", "changed");
		policy.document.policy.checks = [
			check("a-mutate", {
				argv: [
					process.execPath,
					"-e",
					"require('fs').writeFileSync('pkg/source.ts','during-check'); console.log('Tests 1 passed (1)')",
				],
			}),
			check("b-later"),
		];
		const result = await runVerification(options(before));
		expect(result.records).toHaveLength(1);
		expect(result.records[0]).toMatchObject({
			status: "failed",
			reason: "source_changed",
		});
	});
	it("a changed signed policy invalidates an otherwise passing check", async () => {
		const before = await capture();
		await write("pkg/source.ts", "changed");
		let reads = 0;
		const result = await runVerification({
			...options(before),
			readPolicy: async () => ({
				...policy,
				policyDigest: ++reads > 1 ? "b".repeat(64) : digest,
			}),
		});
		expect(result.records[0]).toMatchObject({
			status: "failed",
			reason: "policy_changed",
		});
	});
	it("strips marker and provider credentials from subprocess environment", async () => {
		const before = await capture();
		await write("pkg/source.ts", "changed");
		const old = process.env.MCPSERVER_API_KEY;
		process.env.MCPSERVER_API_KEY = "fixture-secret";
		try {
			policy.document.policy.checks = [
				check("environment", {
					argv: [
						process.execPath,
						"-e",
						"if(process.env.MCPSERVER_API_KEY) process.exit(4); console.log('Tests 1 passed (1)')",
					],
				}),
			];
			expect((await runVerification(options(before))).records[0].status).toBe(
				"passed",
			);
		} finally {
			if (old === undefined) delete process.env.MCPSERVER_API_KEY;
			else process.env.MCPSERVER_API_KEY = old;
		}
	});
	it("times out a running check rather than accepting an unfinished process", async () => {
		const before = await capture();
		await write("pkg/source.ts", "changed");
		policy.document.policy.checks = [
			check("timeout", {
				argv: [process.execPath, "-e", "setTimeout(()=>{}, 10000)"],
			}),
		];
		expect(
			(await runVerification({ ...options(before), timeoutMs: 50 })).records[0],
		).toMatchObject({ status: "failed", reason: "timeout" });
	});
	it("refuses a working-directory symlink outside the workspace", async () => {
		const outside = await fs.mkdtemp(
			join(tmpdir(), "qb-verification-outside-"),
		);
		try {
			await write(".gitignore", "external\n");
			await fs.symlink(outside, join(root, "external"));
			const before = await capture();
			await write("pkg/source.ts", "changed");
			policy.document.policy.checks = [check("outside", { cwd: "external" })];
			await expect(runVerification(options(before))).rejects.toThrow(
				"working_directory_boundary",
			);
		} finally {
			await fs.rm(outside, { recursive: true, force: true });
		}
	});
});

describe("verification test summary evidence", () => {
	it.each([
		["Tests 33 passed (33)", { passed: 33, failed: 0, skipped: 0, total: 33 }],
		[
			"Tests: 2 failed, 10 passed, 1 skipped, 13 total",
			{ passed: 10, failed: 2, skipped: 1, total: 13 },
		],
		[
			"Passed! - Failed: 0, Passed: 4, Skipped: 0, Total: 4, Duration: 1s",
			{ passed: 4, failed: 0, skipped: 0, total: 4 },
		],
		["4 pass\n0 fail\n1 skip", { passed: 4, failed: 0, skipped: 1, total: 5 }],
	])("parses supported runner summary %s", (text, expected) => {
		expect(parseTestCounts(text)).toEqual(expected);
	});
	it("rejects totals exceeding safe integer precision across summaries", () => {
		expect(
			parseTestCounts(
				[
					"Tests 9007199254740991 passed (9007199254740991)",
					"Tests 2 passed (2)",
				].join(String.fromCharCode(10)),
			),
		).toBeUndefined();
	});
	it("does not mistake a file-suite summary for executed tests", () => {
		expect(parseTestCounts("Test Files 3 passed (3)")).toBeUndefined();
	});
});

// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type Fault,
	PlatformFixture,
} from "./__fixtures__/p1-platform-fixture.js";
import {
	assertExecutableBoundary,
	assertPathBoundary,
} from "./p1-baseline-boundaries.test.js";
import { captureWorkspaceFingerprint } from "./workspace-fingerprint.js";

// O-K-BASELINE-MOCK-RELEASE-001: test-only binding to unchanged production.
// Importing the frozen assertion module also retains all 28 released cases.
// Original workspace-fingerprint.test.ts inputs/assertions/native Linux cases stay intact.
const policyDigest = "a".repeat(64);
const routing = vi.hoisted(() => ({
	active: undefined as PlatformFixture | undefined,
}));
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const promises = new Proxy(actual.promises, {
		get(target, property) {
			const original = Reflect.get(target, property);
			if (typeof original !== "function") return original;
			return (...args: unknown[]) => {
				const fixture = routing.active;
				if (fixture?.owns(args[0]))
					return fixture.invoke(String(property), args);
				return Reflect.apply(original, target, args);
			};
		},
	});
	return { ...actual, promises };
});
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	const { promisify } = await import("node:util");
	const execFile = (...args: Parameters<typeof actual.execFile>) =>
		actual.execFile(...args);
	Object.defineProperty(execFile, promisify.custom, {
		value: async (file: string, args: string[], options: { cwd: string }) => {
			const fixture = routing.active;
			if (fixture && options.cwd === fixture.root)
				return fixture.git(file, args);
			return promisify(actual.execFile)(file, args, options);
		},
	});
	return { ...actual, execFile };
});

afterEach(() => {
	routing.active = undefined;
});

async function modeScenario(fault: Fault): Promise<void> {
	const fixture = new PlatformFixture(fault);
	fixture.add("run.sh", "same");
	routing.active = fixture;
	await assertExecutableBoundary(
		() => fixture.capture(),
		() => {
			void fs.chmod(join(fixture.root, "run.sh"), 0o755);
		},
	);
	expect(
		fixture.calls
			.filter((call) => call.method === "chmod-effect")
			.map((call) => call.mode),
	).toEqual(["100755"]);
	expect(
		fixture.calls.filter((call) => call.method === "handle.readFile"),
	).toHaveLength(4);
	expect(
		fixture.calls.filter((call) => call.method === "handle.close"),
	).toHaveLength(4);
	expect(
		new Set(
			fixture.calls
				.filter((call) => call.method === "handle.readFile")
				.map((call) => call.bytesHex),
		),
	).toEqual(new Set([Buffer.from("same").toString("hex")]));
	expect(
		fixture.calls
			.filter((call) => call.method === "stat-result")
			.map((call) => call.mode),
	).toContain("100755");
	console.log(
		"PLATFORM_PRODUCTION_BINDING",
		JSON.stringify({ scenario: "mode", calls: fixture.calls }),
	);
}
async function pathScenario(fault: Fault): Promise<void> {
	const fixture = new PlatformFixture(fault);
	fixture.gitEnabled = true;
	fixture.add("space name.ts", "one");
	fixture.add("line\nbreak.ts", "two");
	routing.active = fixture;
	await assertPathBoundary(() => fixture.capture());
	expect(fixture.replies).toHaveLength(0);
	expect(
		fixture.calls.filter((call) => call.method === "execFile"),
	).toHaveLength(12);
	expect(
		fixture.calls.filter((call) => call.method === "handle.readFile"),
	).toHaveLength(4);
	expect(
		fixture.calls.filter((call) => call.method === "handle.close"),
	).toHaveLength(4);
	console.log(
		"PLATFORM_PRODUCTION_BINDING",
		JSON.stringify({ scenario: "newline", calls: fixture.calls }),
	);
}
describe("TEST-QB-011: exact released assertions bound to unchanged production with faithful platform dependencies", () => {
	it("executable mode input changes actual production fingerprint with stable bytes", async () => {
		await modeScenario("none");
	});
	for (const fault of [
		"erase-mode",
		"omit-stat",
		"omit-read",
		"inode-drift",
	] as const)
		it(`same executable assertion runner rejects dependency ${fault}`, async () => {
			await expect(modeScenario(fault)).rejects.toThrow();
		});
	it("exact newline and space filenames retain both original production assertions", async () => {
		await pathScenario("none");
	});
	for (const fault of [
		"split-newline",
		"omit-index",
		"wrong-object",
		"wrong-reply",
	] as const)
		it(`same newline assertion runner rejects dependency ${fault}`, async () => {
			await expect(pathScenario(fault)).rejects.toThrow();
		});
	it("native staged executable bit changes real production fingerprint with stable object and working bytes", async () => {
		const root = await fs.mkdtemp(join(tmpdir(), "qb-native-index-binding-"));
		const git = (...args: string[]) =>
			execFileSync("git", ["-c", "core.fsmonitor=false", ...args], {
				cwd: root,
				encoding: "utf8",
				env: {
					...process.env,
					GIT_CONFIG_NOSYSTEM: "1",
					GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
				},
			});
		try {
			await fs.writeFile(join(root, "run.sh"), "same");
			git("init", "-q");
			git("add", "run.sh");
			git("update-index", "--chmod=-x", "run.sh");
			const before = git("ls-files", "--stage", "-z");
			const capture = async () => {
				const value = await captureWorkspaceFingerprint({
					workspacePath: root,
					policyDigest,
				});
				return {
					hash: value.hash,
					files: value.files.map((file) => ({
						path: file.path,
						staged: file.staged.map((entry) => ({ ...entry })),
					})),
				};
			};
			await assertExecutableBoundary(capture, () => {
				git("update-index", "--chmod=+x", "run.sh");
			});
			const after = git("ls-files", "--stage", "-z");
			expect(before.slice(0, 6)).toBe("100644");
			expect(after.slice(0, 6)).toBe("100755");
			expect(after.slice(7)).toBe(before.slice(7));
			expect(await fs.readFile(join(root, "run.sh"), "utf8")).toBe("same");
			console.log(
				"NATIVE_PRODUCTION_INDEX_BINDING",
				JSON.stringify({
					platform: process.platform,
					beforeHex: Buffer.from(before).toString("hex"),
					afterHex: Buffer.from(after).toString("hex"),
				}),
			);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});

// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlatformFixture } from "./__fixtures__/p1-platform-fixture.js";
import {
	captureWorkspaceFingerprint,
	changedSourcePaths,
} from "./workspace-fingerprint.js";

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
	return {
		...actual,
		execFile,
		execFileSync: (...args: Parameters<typeof actual.execFileSync>) => {
			const fixture = routing.active;
			const options = args[2] as { cwd?: string } | undefined;
			if (fixture && options?.cwd === fixture.root)
				return fixture.gitSync(String(args[0]), args[1] as string[]);
			return actual.execFileSync(...args);
		},
	};
});

describe("TEST-QB-011: host captures all scoped working and staged source", () => {
	let root: string;
	const policyDigest = "a".repeat(64);
	const capture = () => {
		routing.active?.scriptCapture();
		return captureWorkspaceFingerprint({ workspacePath: root, policyDigest });
	};
	const bindPlatformCase = () => {
		if (!routing.active && process.platform === "win32")
			routing.active = new PlatformFixture("none", root);
	};
	const write = async (path: string, text: string) => {
		await fs.mkdir(join(root, path, ".."), { recursive: true });
		await fs.writeFile(join(root, path), text);
	};
	const git = (...args: string[]) =>
		execFileSync("git", args, {
			cwd: root,
			encoding: "utf8",
			env: {
				...process.env,
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_CONFIG_GLOBAL: "/dev/null",
			},
		});
	beforeEach(async () => {
		root = await fs.mkdtemp(join(tmpdir(), "qb-fingerprint-"));
	});
	afterEach(async () => {
		if (routing.active)
			console.log(
				"ORIGINAL_PLATFORM_CASE_BINDING",
				JSON.stringify({
					platform: process.platform,
					calls: routing.active.calls,
					remainingGitReplies: routing.active.replies.length,
				}),
			);
		routing.active = undefined;
		vi.restoreAllMocks();
		await fs.rm(root, { recursive: true, force: true });
	});

	it("detects command-made untracked edits, deletions and deterministic ordering without git", async () => {
		await write("z.ts", "last");
		await write("a.ts", "first");
		const first = await capture();
		expect((await capture()).hash).toBe(first.hash);
		expect(first.files.map((file) => file.path)).toEqual(["a.ts", "z.ts"]);
		await write("nested/new.ts", "new");
		await write("a.ts", "changed");
		await fs.unlink(join(root, "z.ts"));
		const second = await capture();
		expect(second.hash).not.toBe(first.hash);
		expect(changedSourcePaths(first, second)).toEqual([
			"a.ts",
			"nested/new.ts",
			"z.ts",
		]);
	});
	it("binds policy digest and actual workspace identity", async () => {
		await write("source.ts", "same");
		const first = await capture();
		const changed = await captureWorkspaceFingerprint({
			workspacePath: root,
			policyDigest: "b".repeat(64),
		});
		expect(changed.hash).not.toBe(first.hash);
		await expect(
			captureWorkspaceFingerprint({
				workspacePath: root,
				policyDigest: "invalid",
			}),
		).rejects.toThrow();
		await expect(
			captureWorkspaceFingerprint({ workspacePath: "relative", policyDigest }),
		).rejects.toThrow();
	});
	it("honors nested gitignore negation and independent clineignore exclusions", async () => {
		await write(".gitignore", "*.log\nignored/\n");
		await write("nested/.gitignore", "!keep.log\n");
		await write(".clineignore", "private.ts\n");
		await write("nested/keep.log", "include");
		await write("nested/drop.log", "exclude");
		await write("private.ts", "private");
		await write("ignored/hidden.ts", "hidden");
		const first = await capture();
		expect(first.files.map((file) => file.path)).toEqual([
			".clineignore",
			".gitignore",
			"nested/.gitignore",
			"nested/keep.log",
		]);
		await write("private.ts", "changed private");
		await write("ignored/hidden.ts", "changed");
		expect((await capture()).hash).toBe(first.hash);
	});
	it("excludes credentials, dependencies, runtime state and review receipts before reading them", async () => {
		for (const path of [
			".env",
			".secrets",
			".npmrc",
			".git-credentials",
			"secret.pem",
			".creds/config.yaml",
			"AGENTS-README-FIRST.yaml",
			"node_modules/dep/index.js",
			".mcpServer/events.json",
			"docs/receipts/result.json",
		])
			await write(path, "DO_NOT_HASH");
		await write("src/app.ts", "source");
		expect((await capture()).files.map((file) => file.path)).toEqual([
			"src/app.ts",
		]);
	});
	it("retains source scripts under a re-included coverage directory", async () => {
		await write(".gitignore", "coverage\n!.github/scripts/coverage/\n");
		await write(".github/scripts/coverage/check.ts", "source");
		await write("coverage/output.json", "generated");
		const result = await capture();
		expect(result.files.map((file) => file.path)).toEqual([
			".github/scripts/coverage/check.ts",
			".gitignore",
		]);
	});
	it("includes staged state even when working content is restored", async () => {
		git("init", "-q");
		await write("source.ts", "original");
		git("add", "source.ts");
		const first = await capture();
		await write("source.ts", "staged edit");
		git("add", "source.ts");
		await write("source.ts", "original");
		const second = await capture();
		expect(second.hash).not.toBe(first.hash);
		expect(changedSourcePaths(first, second)).toEqual(["source.ts"]);
	});
	it("retains staged-deletion paths and binds HEAD revision", async () => {
		git("init", "-q");
		await write("source.ts", "source");
		git("add", ".");
		git(
			"-c",
			"user.name=Fixture",
			"-c",
			"user.email=fixture@example.invalid",
			"commit",
			"-qm",
			"fixture",
		);
		const first = await capture();
		expect(first.revision).toMatch(/^[a-f0-9]{40,64}$/);
		git("rm", "-q", "source.ts");
		const second = await capture();
		expect(second.hash).not.toBe(first.hash);
		expect(changedSourcePaths(first, second)).toEqual(["source.ts"]);
	});
	it("honors repository-local excludes without reading excluded files", async () => {
		git("init", "-q");
		await write(".git/info/exclude", "local-output/\n");
		await write("local-output/receipt.txt", "private");
		await write("src.ts", "source");
		expect((await capture()).files.map((file) => file.path)).toEqual([
			"src.ts",
		]);
	});
	it("tracks symlink identity but refuses links outside the workspace", async () => {
		await write("src.ts", "source");
		await fs.symlink("src.ts", join(root, "linked.ts"));
		expect((await capture()).files.map((file) => file.path)).toEqual([
			"linked.ts",
			"src.ts",
		]);
		await fs.unlink(join(root, "linked.ts"));
		await fs.symlink("../external-secret", join(root, "linked.ts"));
		await expect(capture()).rejects.toThrow();
	});
	it("a symlink cannot expose an otherwise ignored secret to source hashing", async () => {
		await write(".env", "secret");
		await fs.symlink(".env", join(root, "public.ts"));
		await expect(capture()).rejects.toThrow();
	});
	const executableModeCase = async () => {
		bindPlatformCase();
		await write("run.sh", "echo fixture");
		await fs.chmod(join(root, "run.sh"), 0o644);
		const first = await capture();
		await fs.chmod(join(root, "run.sh"), 0o755);
		expect((await capture()).hash).not.toBe(first.hash);
	};
	it("invalidates evidence when executable mode changes", executableModeCase);
	for (const fault of [
		"erase-mode",
		"omit-stat",
		"omit-read",
		"inode-drift",
	] as const)
		it(`original executable-mode case rejects ${fault}`, async () => {
			routing.active = new PlatformFixture(fault, root);
			await expect(executableModeCase()).rejects.toThrow();
		});
	it("distinguishes symlinks from files with bytes matching link encoding", async () => {
		await write("src.ts", "source");
		await fs.symlink("src.ts", join(root, "linked.ts"));
		const first = await capture();
		await fs.unlink(join(root, "linked.ts"));
		await write("linked.ts", "symlink\0src.ts");
		expect((await capture()).hash).not.toBe(first.hash);
	});
	it("refuses a source file changed during the read", async () => {
		await write("src.ts", "original");
		const original = fs.open.bind(fs);
		vi.spyOn(fs, "open").mockImplementation(
			async (...args: Parameters<typeof fs.open>) => {
				const handle = await original(...args);
				if (String(args[0]) === join(root, "src.ts")) {
					const read = handle.readFile.bind(handle);
					handle.readFile = (async (
						...options: Parameters<typeof handle.readFile>
					) => {
						const bytes = await read(...options);
						await fs.writeFile(join(root, "src.ts"), "concurrent replacement");
						return bytes;
					}) as typeof handle.readFile;
				}
				return handle;
			},
		);
		await expect(capture()).rejects.toThrow(
			"stable, scoped source fingerprint",
		);
	});
	const stagedPathCase = async () => {
		bindPlatformCase();
		git("init", "-q");
		await write("space name.ts", "one");
		await write("line\nbreak.ts", "two");
		git("add", ".");
		const state = await capture();
		expect(state.files.map((file) => file.path)).toEqual([
			"line\nbreak.ts",
			"space name.ts",
		]);
		expect(state.files.every((file) => file.staged.length === 1)).toBe(true);
	};
	it(
		"uses staged path boundaries without splitting spaces or newlines",
		stagedPathCase,
	);
	for (const fault of ["split-newline", "omit-index", "wrong-reply"] as const)
		it(`original staged-path case rejects ${fault}`, async () => {
			routing.active = new PlatformFixture(fault, root);
			await expect(stagedPathCase()).rejects.toThrow();
		});
});

import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { toPosixSeparators } from "./path";
import { assertPath, observePath, pathVectors, type PathPort } from "./path-contract.fixture";

// The native branch always exercises the original native module. Only the
// foreign platform's dependency is bound; no filesystem/platform claim is made.
async function bindSeparator(separator: string) {
	const nativePath = await import("node:path");
	vi.resetModules();
	vi.doMock("node:path", () => ({ ...nativePath, default: { ...nativePath.default, sep: separator } }));
	try {
		return (await import("./path")).toPosixSeparators;
	} finally {
		vi.doUnmock("node:path");
		vi.resetModules();
	}
}
let posixToPosixSeparators = toPosixSeparators;
let windowsToPosixSeparators = toPosixSeparators;
beforeAll(async () => {
	if (process.platform === "win32") posixToPosixSeparators = await bindSeparator("/");
	else windowsToPosixSeparators = await bindSeparator("\\");
});

describe("toPosixSeparators", () => {
	it("rewrites the platform separator to forward slashes", () => {
		expect(toPosixSeparators(["src", "main.ts"].join(path.sep))).toBe(
			"src/main.ts",
		);
		expect(
			toPosixSeparators(["cline", "evals", "README.md"].join(path.sep)),
		).toBe("cline/evals/README.md");
	});

	it("leaves forward slashes and empty input untouched", () => {
		expect(toPosixSeparators("src/main.ts")).toBe("src/main.ts");
		expect(toPosixSeparators("")).toBe("");
		expect(toPosixSeparators("README.md")).toBe("README.md");
	});

	it("keeps a literal backslash in a POSIX filename", () => {
		expect(posixToPosixSeparators("foo\\bar.txt")).toBe("foo\\bar.txt");
		expect(posixToPosixSeparators("dir/foo\\bar.txt")).toBe("dir/foo\\bar.txt");
	});

	it("rewrites every backslash on Windows", () => {
		expect(windowsToPosixSeparators("src\\a\\b\\c.ts")).toBe("src/a/b/c.ts");
	});

	for (const vector of pathVectors) {
		it(vector.id + " binds SAME proven contract to unchanged production", () => {
			const convert = vector.separator === "/" ? posixToPosixSeparators : windowsToPosixSeparators;
			const calls: string[] = [];
			const port: PathPort = { calls, convert(input) { calls.push(input); return convert(input); } };
			assertPath(vector, observePath(port, vector.input));
		});
	}
});

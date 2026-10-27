import { deepStrictEqual } from "node:assert/strict";

// Original path.test.ts inputs and path.ts's existing platform-only contract.
// Test-only: these expectations are never supplied to a provider/model.
export const pathVectors = [
	{ id: "posix-source", separator: "/", input: "src/main.ts", expected: "src/main.ts" },
	{ id: "posix-readme", separator: "/", input: "cline/evals/README.md", expected: "cline/evals/README.md" },
	{ id: "posix-forward", separator: "/", input: "src/main.ts", expected: "src/main.ts" },
	{ id: "posix-empty", separator: "/", input: "", expected: "" },
	{ id: "posix-basename", separator: "/", input: "README.md", expected: "README.md" },
	{ id: "posix-literal-backslash", separator: "/", input: "foo\\bar.txt", expected: "foo\\bar.txt" },
	{ id: "posix-nested-literal", separator: "/", input: "dir/foo\\bar.txt", expected: "dir/foo\\bar.txt" },
	{ id: "windows-source", separator: "\\", input: "src\\main.ts", expected: "src/main.ts" },
	{ id: "windows-readme", separator: "\\", input: "cline\\evals\\README.md", expected: "cline/evals/README.md" },
	{ id: "windows-forward", separator: "\\", input: "src/main.ts", expected: "src/main.ts" },
	{ id: "windows-empty", separator: "\\", input: "", expected: "" },
	{ id: "windows-basename", separator: "\\", input: "README.md", expected: "README.md" },
	{ id: "windows-all-separators", separator: "\\", input: "src\\a\\b\\c.ts", expected: "src/a/b/c.ts" },
] as const;

export interface PathPort {
	convert(input: string): string;
	calls: string[];
}
export function observePath(port: PathPort, input: string) {
	return { result: port.convert(input), calls: [...port.calls] };
}
export function assertPath(
	vector: (typeof pathVectors)[number],
	actual: ReturnType<typeof observePath>,
) {
	deepStrictEqual(actual, { result: vector.expected, calls: [vector.input] }, "PATH_CONTRACT: exact original output and input interaction");
}

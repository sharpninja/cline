// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, it } from "vitest";
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { remoteHelperBinaryFilename } from "@cline/core";
import { resolveDesktopRemoteHelper } from "./remote-helper";
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
const target = { platform: "linux", arch: "x64" } as const;
const name = remoteHelperBinaryFilename(target);
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "qb-helper-"));
	roots.push(root);
	const bin = join(root, "usr/bin");
	mkdirSync(bin, { recursive: true });
	return {
		root,
		bin,
		options: {
			execPath: join(bin, "cline-qb-sidecar"),
			cwd: root,
			env: {},
			sourceDirectory: null,
		} as NonNullable<Parameters<typeof resolveDesktopRemoteHelper>[1]>,
	};
}
function file(path: string, body: string | Buffer = "helper") {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, body);
	return path;
}
it.each([
	"CLINE_REMOTE_HELPER_BINARY",
	"CLINE_REMOTE_HELPER_DIRECTORY",
])("AC053 ignores upstream override %s", (key) => {
	const { root, options } = fixture();
	const upstream = file(join(root, "upstream", name));
	options.env![key] = key.endsWith("DIRECTORY") ? dirname(upstream) : upstream;
	expect(resolveDesktopRemoteHelper(target, options)).toBeUndefined();
});
it.each([
	"Cline",
	"Cline Beta",
	"unrelated",
])("AC053 never searches Linux resource directory %s", (product) => {
	const { root, options } = fixture();
	file(join(root, "usr/lib", product, "bin/remote-helpers", name));
	expect(resolveDesktopRemoteHelper(target, options)).toBeUndefined();
});
it.each([
	"cline-qb",
	"cline-qb beta",
	"cline-qb dev",
	"cline-qb nightly",
])("resolves governed Linux resources for %s", (product) => {
	const { root, options } = fixture();
	const helper = file(
		join(root, "usr/lib", product, "bin/remote-helpers", name),
	);
	expect(resolveDesktopRemoteHelper(target, options)).toBe(helper);
});
it("does not load executable code from the opened workspace", () => {
	const { root, options } = fixture();
	file(join(root, "src-tauri/bin/remote-helpers", name));
	file(
		join(root, "apps/examples/desktop-app/src-tauri/bin/remote-helpers", name),
	);
	expect(resolveDesktopRemoteHelper(target, options)).toBeUndefined();
});
it("uses the pinned developer source directory even when workspace differs", () => {
	const { root, options } = fixture();
	options.sourceDirectory = join(root, "checkout");
	options.execPath = "/usr/bin/bun";
	const helper = file(
		join(options.sourceDirectory!, "src-tauri/bin/remote-helpers", name),
	);
	file(join(root, "src-tauri/bin/remote-helpers", name), "untrusted");
	expect(resolveDesktopRemoteHelper(target, options)).toBe(helper);
});
it.each(["file", "directory"])("rejects bundled %s symlink escapes", (kind) => {
	const { root, bin, options } = fixture();
	const outside = file(join(root, "outside", name));
	const bundled = join(bin, "remote-helpers", name);
	mkdirSync(dirname(bundled), { recursive: true });
	if (kind === "file") symlinkSync(outside, bundled);
	else {
		rmSync(dirname(bundled), { recursive: true });
		symlinkSync(dirname(outside), dirname(bundled), "junction");
	}
	expect(resolveDesktopRemoteHelper(target, options)).toBeUndefined();
});
it("rejects resource directory aliases into upstream resources", () => {
	const { root, options } = fixture();
	const upstream = file(join(root, "usr/lib/Cline/bin/remote-helpers", name));
	symlinkSync(
		join(root, "usr/lib/Cline"),
		join(root, "usr/lib/cline-qb"),
		"junction",
	);
	expect(resolveDesktopRemoteHelper(target, options)).toBeUndefined();
});
it("a directory with the helper filename is not an executable file", () => {
	const { bin, options } = fixture();
	mkdirSync(join(bin, "remote-helpers", name), { recursive: true });
	expect(resolveDesktopRemoteHelper(target, options)).toBeUndefined();
});
it("does not borrow resources adjacent to the system Bun binary", () => {
	const { bin, options } = fixture();
	options.execPath = join(bin, "bun");
	file(join(bin, "remote-helpers", name));
	expect(resolveDesktopRemoteHelper(target, options)).toBeUndefined();
});
it("rejects a thin Mac developer sidecar for the wrong architecture", () => {
	const { root, options } = fixture();
	options.sourceDirectory = join(root, "checkout");
	options.execPath = "/usr/bin/bun";
	options.platform = "darwin";
	file(
		join(
			options.sourceDirectory,
			"src-tauri/bin/cline-qb-sidecar-x86_64-apple-darwin",
		),
		Buffer.from("cffaedfe0c000001", "hex"),
	);
	expect(
		resolveDesktopRemoteHelper({ platform: "darwin", arch: "x64" }, options),
	).toBeUndefined();
});

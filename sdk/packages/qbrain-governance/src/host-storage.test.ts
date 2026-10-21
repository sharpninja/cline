// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveHostDocumentsDirectories } from "./host-storage";

const roots: string[] = [];
function home() {
	const p = mkdtempSync(join(tmpdir(), "qb-host-documents-"));
	roots.push(p);
	return p;
}
function config(root: string, text: string) {
	mkdirSync(join(root, ".config"), { recursive: true });
	writeFileSync(join(root, ".config", "user-dirs.dirs"), text);
}
afterEach(() => {
	for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});
describe("TEST-QB-002/053: host Documents discovery and bootstrap", () => {
	it("uses the home Documents fallback when Linux configuration is absent", () => {
		const root = home();
		expect(
			resolveHostDocumentsDirectories({
				homeDir: root,
				platform: "linux",
				env: {},
			}),
		).toEqual([join(root, "Documents")]);
	});
	it("resolves the final configured HOME path without evaluating shell syntax", () => {
		const root = home();
		config(
			root,
			'XDG_DOCUMENTS_DIR="$HOME/Old"\nXDG_DOCUMENTS_DIR="${HOME}/Work Documents" # selected\n',
		);
		expect(
			resolveHostDocumentsDirectories({
				homeDir: root,
				platform: "linux",
				env: {},
			}),
		).toEqual([join(root, "Work Documents")]);
	});
	it.each([
		"XDG_DOCUMENTS_DIR=relative",
		'XDG_DOCUMENTS_DIR="$OTHER/Documents"',
		'XDG_DOCUMENTS_DIR="$(touch bad)"',
		'XDG_DOCUMENTS_DIR="`touch bad`"',
		'XDG_DOCUMENTS_DIR="\\$HOME/Documents"',
		'XDG_DOCUMENTS_DIR="relative"',
	])("refuses malformed or executable configuration: %s", (text) => {
		const root = home();
		config(root, text);
		expect(() =>
			resolveHostDocumentsDirectories({
				homeDir: root,
				platform: "linux",
				env: {},
			}),
		).toThrow();
	});
	it("refuses an XDG config location inside upstream storage before reading it", () => {
		const root = home();
		expect(() =>
			resolveHostDocumentsDirectories({
				homeDir: root,
				platform: "linux",
				env: { XDG_CONFIG_HOME: join(root, ".cline") },
			}),
		).toThrow(/upstream Cline/);
	});
	it("uses the host-provided redirected Windows Documents path", () => {
		const root = home();
		const docs = join(root, "Redirected Documents");
		expect(
			resolveHostDocumentsDirectories({
				homeDir: root,
				platform: "win32",
				queryWindowsDocuments: () => docs + "\r\n",
			}),
		).toEqual([docs]);
	});
	it.each([
		"",
		"relative",
	])("refuses invalid Windows known-folder result: %s", (result) => {
		expect(() =>
			resolveHostDocumentsDirectories({
				homeDir: home(),
				platform: "win32",
				queryWindowsDocuments: () => result,
			}),
		).toThrow(/absolute Windows/);
	});
	it("surfaces a failed Windows known-folder query", () => {
		expect(() =>
			resolveHostDocumentsDirectories({
				homeDir: home(),
				platform: "win32",
				queryWindowsDocuments: () => {
					throw new Error("known-folder unavailable");
				},
			}),
		).toThrow("known-folder unavailable");
	});
	it("uses Documents under home on other hosts", () => {
		const root = home();
		expect(
			resolveHostDocumentsDirectories({
				homeDir: root,
				platform: "darwin",
				env: {},
			}),
		).toEqual([join(root, "Documents")]);
	});
	it("reuses one immutable namespace across repeat built-host initialization", () => {
		const root = home();
		const url = new URL("../dist/host-storage.js", import.meta.url).href;
		const child = spawnSync(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				`const {initializeQbrainStorage}=await import(${JSON.stringify(url)}); const a=initializeQbrainStorage(); const b=initializeQbrainStorage(); if(a!==b) throw new Error('namespace changed'); console.log(a.resolvePath('root',{homeDir:process.env.HOME}));`,
			],
			{
				encoding: "utf8",
				timeout: 30000,
				env: {
					PATH: process.env.PATH,
					HOME: root,
					USERPROFILE: root,
					SystemRoot: process.env.SystemRoot,
				},
			},
		);
		expect(child.error).toBeUndefined();
		expect(child.status, child.stderr).toBe(0);
		expect(child.stdout.trim()).toBe(join(root, ".cline-qb"));
	});
});
